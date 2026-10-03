param([string]$Source = (Join-Path $PSScriptRoot '../launcher/Assets/avatar.jpg'),
      [string]$Destination = (Join-Path $PSScriptRoot '../launcher/Assets/app.ico'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$original = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $Source))
$frames = @()
try {
    foreach ($size in @(16, 24, 32, 48, 64, 128, 256)) {
        $bitmap = [System.Drawing.Bitmap]::new($size, $size)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.DrawImage($original, 0, 0, $size, $size)
        $stream = [System.IO.MemoryStream]::new()
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $frames += @{ Size = $size; Bytes = $stream.ToArray() }
        $graphics.Dispose(); $bitmap.Dispose(); $stream.Dispose()
    }
    $writer = [System.IO.BinaryWriter]::new([System.IO.File]::Create([System.IO.Path]::GetFullPath($Destination)))
    try {
        $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$frames.Count)
        $offset = 6 + 16 * $frames.Count
        foreach ($frame in $frames) {
            $sizeByte = if ($frame.Size -eq 256) { 0 } else { $frame.Size }
            $writer.Write([byte]$sizeByte); $writer.Write([byte]$sizeByte)
            $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]32)
            $writer.Write([uint32]$frame.Bytes.Length); $writer.Write([uint32]$offset)
            $offset += $frame.Bytes.Length
        }
        foreach ($frame in $frames) { $writer.Write([byte[]]$frame.Bytes) }
    } finally { $writer.Dispose() }
} finally { $original.Dispose() }
