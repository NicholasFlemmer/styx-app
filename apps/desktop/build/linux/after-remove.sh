#!/bin/sh
# Styx .deb post-remove: drop the polkit action installed by after-install.sh.
rm -f /usr/share/polkit-1/actions/com.heystyx.styx.policy
