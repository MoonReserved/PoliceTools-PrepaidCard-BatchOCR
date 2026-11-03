These are synthetic, public test images with the serial 12345678901234 and colour markers. No user photos or card data are included.
Regenerate with Pillow 13.0.0 and pillow-heif 1.8.1:
  python3 tests/make-image-fixtures.py [path/to/bold-font.ttf]
The default font path is Arial Bold on macOS. The font itself is not distributed.
HEIC fixtures cover 8/10-bit, all eight container orientations and non-first primary image.
TIFF fixtures cover multipage, orientation, grayscale, CMYK, Fax4, LZW, Deflate, PackBits and JPEG compression.
GIF contains a black second frame to verify that importing uses the first frame.
