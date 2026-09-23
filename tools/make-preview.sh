#!/bin/sh
# The GitHub social-preview / link-card image for the repository.
#
# Optional and maintainer-only: it needs ImageMagick and a DejaVu font, neither of
# which the app or the test suite touches. The mark itself comes from the generated
# PNG (see tools/make-icons.mjs — one geometry, every size), so this only composes
# it with type; running it twice gives the same file.
#
#   sh tools/make-preview.sh        → assets/social-preview.png (1280x640)
set -e
cd "$(dirname "$0")/.."
FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
magick -size 1280x640 xc:'#070b14' \
  -fill '#10233b' -draw 'circle 1080,-140 1080,320' \
  -fill '#0d1a2e' -draw 'circle 80,720 80,380' \
  \( assets/icon-512.png -resize 300x300 \) -geometry +96+170 -compose over -composite \
  -font "$FONT" -fill '#e8eef8' -pointsize 92 -annotate +456+300 'MailDrop' \
  -fill '#38bdf8' -pointsize 34 -annotate +460+372 'Files too big for an email' \
  -fill '#94a3b8' -pointsize 28 -annotate +460+436 'one link, no account, no server of yours' \
  -fill '#64748b' -pointsize 22 -annotate +460+498 'static page  ·  MIT  ·  yours to host' \
  PNG24:assets/social-preview.png
identify assets/social-preview.png
