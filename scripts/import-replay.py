"""只读导入用户提供的回放 XML，保留原文并再次匿名化，不获取网络数据。"""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import re
import secrets
import unicodedata
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parent.parent
BVID = 'BV13Yaf6qEBW'
DURATION = 7213
EXPECTED_CIDS = {3: 42346482280, 4: 42346482449}
MAX_SOURCE_BYTES = 20 * 1024 * 1024
MAX_DATASET_BYTES = 20 * 1024 * 1024
MAX_MESSAGES = 100000
DEFAULT_PATHS = {
    3: Path('D:/Program Files/JiJiDown/Download/【直播回放】斗！ 2026年09月30日12点场 - 3.2-斗！(Av117360669231710,P3).xml'),
    4: Path('D:/Program Files/JiJiDown/Download/【直播回放】斗！ 2026年09月30日12点场 - 4.3-斗！(Av117360669231710,P4).xml'),
}
EQUIPMENT_TERMS = [
    '灭世者的死亡之帽', '帽子', '金身', '中亚', '中娅', '法穿棒', '虚空之杖',
    '无尽', '心之钢', '心之刚', '破败', '焚天', '冰拳', '冰杖', '大天使',
    '峡谷制造者', '海妖', '狂徒', '黑切', '饮血', '卢登', '兰德里', '装备', '出装',
]


def hash_token(salt, kind, value):
    return hashlib.sha256(salt + b'\0' + kind.encode() + b'\0' + value.encode()).hexdigest()[:24]


def command(text):
    value = unicodedata.normalize('NFKC', text).strip().lower()
    return value if re.fullmatch(r'[123]d?', value) else None


def equipment_terms(text):
    return [term for term in EQUIPMENT_TERMS if term in text]


def import_xml(path, page, salt):
    if not path.is_file():
        raise FileNotFoundError('source-file-missing')
    source_bytes = path.stat().st_size
    if source_bytes > MAX_SOURCE_BYTES:
        raise ValueError('source-file-too-large')
    rows = 0
    skipped = 0
    missing_identity = 0
    fallback_ids = 0
    min_at = None
    max_at = None
    headers = {}
    messages = []
    for _, element in ET.iterparse(path, events=('end',)):
        if element.tag == 'd':
            rows += 1
            parts = element.attrib.get('p', '').split(',')
            text = ''.join(element.itertext())
            try:
                at = float(parts[0])
                if not math.isfinite(at) or at < 0 or not text:
                    raise ValueError('invalid-message')
            except (ValueError, IndexError):
                skipped += 1
                element.clear()
                continue
            min_at = at if min_at is None else min(min_at, at)
            max_at = at if max_at is None else max(max_at, at)
            anonymous_seed = parts[6] if len(parts) > 6 else ''
            if anonymous_seed and anonymous_seed != '0':
                anonymous_id = hash_token(salt, 'anonymous', anonymous_seed)
            else:
                anonymous_id = None
                missing_identity += 1
            message_seed = parts[7] if len(parts) > 7 else ''
            if message_seed and message_seed != '0':
                message_id = hash_token(salt, 'message', f'{page}:{message_seed}')
            else:
                fallback_ids += 1
                message_id = hash_token(salt, 'fallback', f'{page}:{rows}:{at}:{text}')
            if len(messages) < MAX_MESSAGES:
                messages.append({'id': message_id, 'text': text, 'anonymousId': anonymous_id, 'at': at})
        elif element.tag in ('chatid', 'maxlimit', 'state'):
            headers[element.tag] = element.text
        element.clear()
    cid = int(headers.get('chatid') or 0)
    if cid != EXPECTED_CIDS[page]:
        raise ValueError('source-cid-does-not-match-selected-page')
    messages.sort(key=lambda item: (item['at'], item['id']))
    coverage = {
        'kind': 'user-provided-jijidown-xml',
        'sourceRows': rows,
        'retainedMessages': len(messages),
        'skippedRows': skipped,
        'truncated': rows - skipped > len(messages),
        'firstAtSeconds': min_at,
        'lastAtSeconds': max_at,
        'xmlHeaderMaxlimit': headers.get('maxlimit'),
        'missingAnonymousIdentity': missing_identity,
        'fallbackMessageIds': fallback_ids,
        'description': '解析用户提供的弹幕文件，时间相对各自分 P；不代表全部直播原始弹幕。',
        'limitations': [
            '文件可能包含回放观看弹幕或直播弹幕转存，无法据此保证原始直播全量覆盖。',
            'XML 的 maxlimit 仅作为原始元数据保留，不解释为实际条数或抓取方式。',
            '匿名标识依据文件中的匿名来源再次加盐哈希，不能据此保证精确观众人数。',
            '每次重新导入使用新盐；不同导入之间的匿名标识不能关联。',
            '各分 P 的时间独立；切换分 P 或回放跳转时应清空当前轮次。',
        ],
    }
    dataset = {
        'id': f'azusa-p{page}',
        'label': f'P{page} 阿梓回放',
        'bvid': BVID,
        'page': page,
        'cid': cid,
        'duration': DURATION,
        'coverage': coverage,
        'source': {
            'kind': 'user-provided-file',
            'fileName': path.name,
            'url': f'https://www.bilibili.com/video/{BVID}/?p={page}',
            'originalFileModified': False,
            'messageIdMethod': '会话加盐 SHA-256 截取；来源缺失时按分 P、原始行序、时间及原文生成。',
            'anonymousIdMethod': '对 XML 的 p[6] 再次会话加盐哈希；来源缺失为 null，不合并成一个观众。',
            'durationSource': '用户指定 BV 的正常游客元数据接口，两个分 P 都为 7213 秒。',
        },
        'messages': messages,
    }
    serialized = json.dumps(dataset, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    if len(serialized) > MAX_DATASET_BYTES:
        raise ValueError('dataset-exceeds-size-limit')
    return dataset, serialized, source_bytes


def inspect(dataset, source_bytes, output_bytes):
    bins = defaultdict(list)
    votes = []
    equipment = []
    repeats = defaultdict(list)
    ids = Counter()
    for item in dataset['messages']:
        bins[int(item['at'] // 10) * 10].append(item)
        ids[item['id']] += 1
        token = command(item['text'])
        if token:
            votes.append(item)
            if item['anonymousId']:
                repeats[(item['anonymousId'], token)].append(item['at'])
        if equipment_terms(item['text']):
            equipment.append(item)

    def window(start, items):
        command_counts = Counter(filter(None, (command(item['text']) for item in items)))
        return {
            'startAtSeconds': start,
            'endAtSeconds': min(start + 10, dataset['duration']),
            'messages': len(items),
            'exactVoteMessages': sum(command_counts.values()),
            'commandCounts': dict(command_counts),
            'equipmentKeywordMessages': sum(bool(equipment_terms(item['text'])) for item in items),
        }

    dense = sorted(bins.items(), key=lambda pair: (-len(pair[1]), pair[0]))[:10]
    vote_windows = sorted(
        ((start, items) for start, items in bins.items() if any(command(item['text']) for item in items)),
        key=lambda pair: (-sum(bool(command(item['text'])) for item in pair[1]), pair[0]),
    )[:10]
    equipment_windows = sorted(
        ((start, items) for start, items in bins.items() if any(equipment_terms(item['text']) for item in items)),
        key=lambda pair: (-sum(bool(equipment_terms(item['text'])) for item in pair[1]), pair[0]),
    )[:10]
    repeated = []
    for (anonymous_id, token), times in repeats.items():
        for index in range(1, len(times)):
            if times[index] - times[index - 1] <= 10:
                repeated.append({
                    'anonymousId': anonymous_id, 'command': token,
                    'earlierAtSeconds': times[index - 1], 'laterAtSeconds': times[index],
                })
    semantic_examples = []
    complex_words = ('别', '不要', '先', '再', '或者', '还是', '出', '买', '做', '就')
    for item in equipment:
        if any(word in item['text'] for word in complex_words):
            semantic_examples.append({'at': item['at'], 'text': item['text'], 'keywordHits': equipment_terms(item['text'])})
    if not semantic_examples:
        semantic_examples = [{'at': item['at'], 'text': item['text'], 'keywordHits': equipment_terms(item['text'])} for item in equipment]
    return {
        'id': dataset['id'], 'page': dataset['page'], 'cid': dataset['cid'],
        'sourceBytes': source_bytes, 'datasetBytes': output_bytes, 'coverage': dataset['coverage'],
        'exactVoteMessages': len(votes),
        'commandCounts': dict(Counter(command(item['text']) for item in votes)),
        'equipmentKeywordMessages': len(equipment),
        'equipmentTermCounts': dict(Counter(term for item in equipment for term in equipment_terms(item['text']))),
        'dense10SecondBins': [window(start, items) for start, items in dense],
        'voteDense10SecondBins': [window(start, items) for start, items in vote_windows],
        'equipmentDense10SecondBins': [window(start, items) for start, items in equipment_windows],
        'sameAnonymousCommandRepeatsWithin10Seconds': len(repeated),
        'repeatExamples': repeated[:20],
        'sameMessageIdRepeats': sum(value - 1 for value in ids.values() if value > 1),
        'equipmentTextExamples': semantic_examples[:30],
        'classificationNote': '字词命中和精确数字指令属于候选筛选，不是人工语义标签，也不能证明对应主播提问。',
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--p3', type=Path, default=DEFAULT_PATHS[3])
    parser.add_argument('--p4', type=Path, default=DEFAULT_PATHS[4])
    arguments = parser.parse_args()
    salt = secrets.token_bytes(32)
    output_dir = ROOT / 'data/replays'
    output_dir.mkdir(parents=True, exist_ok=True)
    report = {
        'scope': '用户提供的 P3／P4 回放弹幕文件导入与候选时间段检查，不是完整直播采集或 AI 准确率测试。',
        'bvid': BVID,
        'networkRequestsDuringImport': 0,
        'originalFilesModified': False,
        'identitySaltSaved': False,
        'datasets': [],
    }
    for page, source in ((3, arguments.p3), (4, arguments.p4)):
        dataset, serialized, source_bytes = import_xml(source, page, salt)
        (output_dir / f'azusa-p{page}.json').write_bytes(serialized)
        report['datasets'].append(inspect(dataset, source_bytes, len(serialized)))
    destination = ROOT / 'validation/replay-inspection.json'
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({
        'status': 'imported',
        'datasets': [{'id': item['id'], 'messages': item['coverage']['retainedMessages'], 'bytes': item['datasetBytes']} for item in report['datasets']],
        'inspectionPath': str(destination),
    }, ensure_ascii=True))


if __name__ == '__main__':
    main()
