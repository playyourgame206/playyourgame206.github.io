# playyourgame.github.io
## Desktop Simulator: YouTube search

The YouTube app in `desktop_simulator.html` plays real videos with YouTube's
embedded player. Searching inside the app asks YouTube for real results.

Out of the box it uses public YouTube mirrors (Piped and Invidious). They work
most days, but they are run by volunteers and can be down. For dependable
search with strict SafeSearch, give the app a free YouTube Data API key:

1. Go to https://console.cloud.google.com/ and create a project.
2. Under "APIs & Services", enable **YouTube Data API v3**.
3. Under "Credentials", create an **API key**. Restrict it to
   "Websites" and add `playyourgame206.github.io/*` so only this site can use it.
4. In `desktop_simulator.html`, find `const YT_API_KEY = '';` and paste the
   key between the quotes.

The free quota allows about 100 searches a day, which is plenty for a family.

## 3D games on slower devices

Coin Collector, Laundry Simulator and PC Builder share a graphics quality
setting (`quality.js`), in each game's settings menu under **Graphics**:

- **Auto** (the default) guesses a level from the device, then watches the
  frame rate while playing. Below 40 fps for a few seconds it steps down a
  level and shows a short message; after a long stretch at a steady 60 fps
  it tries a level up again.
- **High** is what the games always did: soft shadows, antialiasing, full
  resolution.
- **Medium** renders 720 lines with plain, smaller shadows.
- **Low** renders 540 lines with no shadows, no antialiasing and simple
  shading.

The choice is saved on the device and shared by all three games. Antialiasing
and the simple shading only switch at page load, so a game that Auto turned
down to Low gets their full benefit on the next visit. Add `?quality=low`
(or `medium`, `high`, `auto`) to a game's address to force a level, for
example for a kiosk link. The Raspberry Pi arcade's `?pi=1` mode is separate
and takes precedence.
