"""Regenerate public synthetic fixtures: Pillow + pillow-heif, no private images.
Usage: python3 tests/make-image-fixtures.py [path/to/font.ttf]
"""
from pathlib import Path
import sys
from array import array
from PIL import Image, ImageDraw, ImageFont
import pillow_heif

pillow_heif.register_heif_opener()
dest = Path(__file__).parent / 'fixtures' / 'images'
dest.mkdir(parents=True, exist_ok=True)
font = ImageFont.truetype(sys.argv[1] if len(sys.argv) > 1 else '/System/Library/Fonts/Supplemental/Arial Bold.ttf', 48)
im = Image.new('RGB', (900, 500), 'white')
d = ImageDraw.Draw(im)
d.rectangle((10, 10, 45, 45), fill=(220, 25, 25))
d.rectangle((855, 10, 890, 45), fill=(25, 180, 35))
d.rectangle((10, 455, 45, 490), fill=(25, 40, 220))
d.text((140, 200), '12345678901234', font=font, fill='black')
im.save(dest / 'serial.png')
im.save(dest / 'serial.heic', quality=95)
pillow_heif.from_bytes('RGB;16', im.size, array('H', (v * 257 for v in im.tobytes())).tobytes()).save(dest / 'serial-10bit.heic', quality=95, bit_depth=10)
im.save(dest / 'serial.avif', quality=95)
im.save(dest / 'serial.bmp')
im.save(dest / 'serial.gif', save_all=True, append_images=[Image.new('RGB', im.size, 'black')], duration=50, loop=0)
for mode, name in [('RGB', 'rgb'), ('L', 'gray'), ('CMYK', 'cmyk')]:
 im.convert(mode).save(dest / (name + '.tif'), compression='tiff_lzw')
for compression in ['tiff_adobe_deflate', 'packbits', 'jpeg']:
 im.save(dest / (compression + '.tif'), compression=compression)
im.convert('1').save(dest / 'fax4.tif', compression='group4')
im.save(dest / 'pages.tiff', save_all=True, append_images=[im.transpose(Image.Transpose.ROTATE_180)], compression='tiff_adobe_deflate')
transposes = {2: Image.Transpose.FLIP_LEFT_RIGHT, 3: Image.Transpose.ROTATE_180, 4: Image.Transpose.FLIP_TOP_BOTTOM,
              5: Image.Transpose.TRANSPOSE, 6: Image.Transpose.ROTATE_90, 7: Image.Transpose.TRANSVERSE, 8: Image.Transpose.ROTATE_270}
for orientation in range(2, 9):
 raw = im.transpose(transposes[orientation])
 raw.save(dest / f'orientation-{orientation}.tif', compression='tiff_lzw', tiffinfo={274: orientation})
 exif = Image.Exif(); exif[274] = orientation
 raw.save(dest / f'orientation-{orientation}.heic', quality=95, exif=exif.tobytes())
other = Image.new('RGB', im.size, 'blue')
other.save(dest / 'primary.heic', save_all=True, append_images=[im], primary_index=1, quality=95)
print(f'Generated {len(list(dest.iterdir()))} synthetic fixtures in {dest}')
