#!/bin/sh
# One image with the last moment of every format and mode of a recipe in a style (after recipe-preview.mjs).
d="out/recipes/$1/$2"
pick() { [ -f "$d/$1/moment-4-footage.png" ] && echo "$d/$1/moment-4-footage.png" || echo "$d/$1/moment-4.png"; }
ffmpeg -v error -y -i "$(pick landscape-fullscreen)" -i "$(pick square-fullscreen)" -i "$(pick portrait-fullscreen)" \
  -i "$(pick landscape-overlay)" -i "$(pick square-overlay)" -i "$(pick portrait-overlay)" -filter_complex \
  "[0:v]scale=-2:480[a];[1:v]scale=-2:480[b];[2:v]scale=-2:480[c];[3:v]scale=-2:480[d];[4:v]scale=-2:480[e];[5:v]scale=-2:480[f];[a][b][c]hstack=3[t];[d][e][f]hstack=3[u];[t][u]vstack" \
  -frames:v 1 "$d/all.png" && echo "$d/all.png"
