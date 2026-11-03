These are synthetic, public test images with the serial 12345678901234 and colour markers. No user photos or card data are included.
Regenerate non-HEVC fixtures with Pillow 13.0.0:
  python3 tests/make-image-fixtures.py [path/to/bold-font.ttf]
The default font path is Arial Bold on macOS. The font itself is not distributed.
HEVC-encoded fixtures are no longer distributed. Native HEIC tests can use a local, user-supplied HEIC_FIXTURE_DIR; these files must not be committed.
TIFF fixtures cover multipage, orientation, grayscale, CMYK, Fax4, LZW, Deflate, PackBits and JPEG compression.
GIF contains a black second frame to verify that importing uses the first frame.
