# Portal browser test

Run the real-browser interaction gate with:

```sh
npm run test:browser
```

The test uses an installed Chrome or Chromium executable and does not silently skip when none is available. To select a non-standard installation explicitly:

```sh
API_TRUTH_BROWSER_EXECUTABLE=/absolute/path/to/chrome npm run test:browser
```
