# musicbox karaoke

A private karaoke page for friends: YouTube's player with karaoke lyrics, note bars and a word map
on top, a karaoke-only search, a queue, and its own autoplay and recommendations.

The songs (`data/`) are encrypted (AES-256-GCM, key derived from the password with PBKDF2-SHA256,
600,000 rounds) and are only decrypted in your browser. You need the password to use the page.

Built from the musicbox project (`tools/build-site.mjs`); don't edit these files by hand.
