"""只读导入歌回弹幕，复用脱敏规则，不保存原始身份或修改 XML。"""
import argparse
import importlib.util
import json
import math
from pathlib import Path
import secrets
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("replay_import", ROOT / "scripts" / "import-replay.py")
replay_import = importlib.util.module_from_spec(spec)
spec.loader.exec_module(replay_import)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--p1', type=Path, required=True)
    parser.add_argument('--p2', type=Path, required=True)
    parser.add_argument('--metadata', type=Path)
    options = parser.parse_args()
    metadata = json.loads(options.metadata.read_text(encoding='utf-8')) if options.metadata else None
    pages = {row['page']: row for row in metadata['pages']} if metadata else {}
    salt = secrets.token_bytes(32)
    results = []
    for page, source in ((1, options.p1), (2, options.p2)):
        header = ET.parse(source).getroot()
        cid = int(header.findtext('chatid') or 0)
        latest = max((float(row.attrib.get('p', '0').split(',')[0]) for row in header.findall('d')), default=0)
        information = pages.get(page)
        duration = information['duration'] if information else math.ceil(latest) + 1
        expected_cid = information['cid'] if information else cid
        dataset, _, source_bytes = replay_import.import_xml(source, page, salt,
            bvid='BV1boaW6PEqz', duration=duration, expected_cid=expected_cid,
            dataset_id=f'azusa-singing-p{page}', label=f'P{page} 阿梓歌回',
            duration_source='用户提供回放的公开视频分 P 元数据。' if information
                else '以文件内最后一条弹幕时间向上取整加一秒估计，不代表完整视频长度。')
        dataset['singingStartAt'] = 2790 if page == 1 else 0
        dataset['windows'] = [{'mode': 'songs', 'at': dataset['singingStartAt'], 'label': '歌回开始位置'}]
        target = ROOT / 'data' / 'replays' / (dataset['id'] + '.json')
        target.write_text(json.dumps(dataset, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        results.append({'id': dataset['id'], 'page': page, 'cid': cid, 'sourceBytes': source_bytes,
            'messages': len(dataset['messages']), 'singingMessages': sum(row['at'] >= dataset['singingStartAt'] for row in dataset['messages']),
            'duration': duration, 'singingStartAt': dataset['singingStartAt'], 'coverage': dataset['coverage']})
    report = {'bvid': 'BV1boaW6PEqz', 'originalFilesModified': False, 'identitySaltSaved': False,
        'networkRequestsDuringImport': 0, 'datasets': results}
    (ROOT / 'validation' / 'song-replay-inspection.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'datasets': [{key: row[key] for key in ('id','messages','singingMessages','duration')} for row in results]}, ensure_ascii=False))


if __name__ == '__main__':
    main()
