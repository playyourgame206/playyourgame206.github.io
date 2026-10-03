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
