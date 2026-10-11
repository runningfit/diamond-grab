// Install and offline checks: `node game/tests/pwa.test.cjs`.
//
// A service worker's precache is all or nothing: if one listed file is missing, the install
// fails and the game never works offline, with no error anyone would see. This checks that the
// precache, the page and the manifest all agree with the files that actually exist.
const fs = require('fs');
const path = require('path');

const GAME = path.join(__dirname, '..');
let failures = 0;

/** Report one assertion. */
const check = (name, condition, extra = '') => {
  if (condition) {
    console.log('ok  :', name);
  } else {
    failures += 1;
    console.log('FAIL:', name, extra);
  }
};

/** Read the width and height from a PNG header. */
const pngSize = (file) => {
  const data = fs.readFileSync(file);

  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
};

const sw = fs.readFileSync(path.join(GAME, 'sw.js'), 'utf8');
const shellBlock = sw.match(/const SHELL = \[([\s\S]*?)\];/);

check('sw.js declares a SHELL list', Boolean(shellBlock));

const shell = shellBlock ? [...shellBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];

// The deploy stamps each release into this exact line; if it changes shape the stamp silently
// misses, phones never see new releases, and they keep running the old one.
check('sw.js has the VERSION line the deploy stamps', /^const VERSION = 'dev';$/m.test(sw));
check(
  'the cache is named after the release',
  /const CACHE = `diamond-grab-\$\{VERSION\}`;/.test(sw),
);
check('the release is downloaded bypassing the browser cache', sw.includes("{ cache: 'reload' }"));
const files = shell.filter((entry) => entry !== './');

files.forEach((entry) => {
  check(`precached file exists: ${entry}`, fs.existsSync(path.join(GAME, entry)));
});

// Everything the page loads has to be precached, or the game boots offline without it.
const html = fs.readFileSync(path.join(GAME, 'index.html'), 'utf8');
const loaded = [
  ...[...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]),
  ...[...html.matchAll(/<link rel="(?:stylesheet|manifest|apple-touch-icon)" href="([^"]+)"/g)].map(
    (m) => m[1],
  ),
];

check('index.html loads scripts and styles', loaded.length > 5, `${loaded.length}`);
loaded.forEach((entry) => {
  check(`page asset is precached: ${entry}`, shell.includes(entry));
});

// Any new script or stylesheet added later must be precached too.
['js', 'css'].forEach((dir) => {
  fs.readdirSync(path.join(GAME, dir)).forEach((name) => {
    check(`${dir}/${name} is precached`, shell.includes(`${dir}/${name}`));
  });
});

// The manifest: relative paths so it works under a GitHub Pages sub-path, and real icons.
const manifest = JSON.parse(fs.readFileSync(path.join(GAME, 'manifest.webmanifest'), 'utf8'));

check('manifest start_url is relative', manifest.start_url === './');
check('manifest scope is relative', manifest.scope === './');
check('manifest has a name', Boolean(manifest.name && manifest.short_name));
check(
  'manifest is shown without browser chrome',
  ['fullscreen', 'standalone'].includes(manifest.display),
);

const sizes = new Set();

manifest.icons.forEach((icon) => {
  const file = path.join(GAME, icon.src);
  const exists = fs.existsSync(file);

  check(`manifest icon exists: ${icon.src}`, exists);

  if (exists) {
    const { width, height } = pngSize(file);

    check(`manifest icon is ${icon.sizes}: ${icon.src}`, `${width}x${height}` === icon.sizes);
    sizes.add(`${icon.sizes} ${icon.purpose}`);
  }

  check(`manifest icon is precached: ${icon.src}`, shell.includes(icon.src));
});

check('manifest has a 192px icon', sizes.has('192x192 any'));
check('manifest has a 512px icon', sizes.has('512x512 any'));
check(
  'manifest has a maskable icon',
  [...sizes].some((s) => s.endsWith('maskable')),
);

// Link previews: the deploy swaps this address for the published one, so every preview tag has to
// use it, and the card image has to be the size the big preview cards expect.
const SITE = 'https://runningfit.github.io/diamond-grab/';
const meta = (key) => {
  const found = html.match(new RegExp(`(?:property|name)="${key}"\\s+content="([^"]*)"`));

  return found ? found[1] : '';
};

check('og:url is the site address', meta('og:url') === SITE, meta('og:url'));
check(
  'og:image is the share card',
  meta('og:image') === `${SITE}icons/share.png`,
  meta('og:image'),
);
check(
  'the canonical link is the site address',
  html.includes(`<link rel="canonical" href="${SITE}" />`),
);
check('a large preview card is asked for', meta('twitter:card') === 'summary_large_image');
check('the share card exists', fs.existsSync(path.join(GAME, 'icons/share.png')));

if (fs.existsSync(path.join(GAME, 'icons/share.png'))) {
  const { width, height } = pngSize(path.join(GAME, 'icons/share.png'));

  check('the share card is 1200 x 630', width === 1200 && height === 630, `${width}x${height}`);
}

// Search engines: a robots file and sitemap naming the site, and a description of the game that
// parses, all on the address the deploy rewrites.
const robots = fs.readFileSync(path.join(GAME, 'robots.txt'), 'utf8');
const sitemap = fs.readFileSync(path.join(GAME, 'sitemap.xml'), 'utf8');

check(
  'robots.txt allows everything',
  /^User-agent: \*$/m.test(robots) && /^Allow: \/$/m.test(robots),
);
check('robots.txt names the sitemap', robots.includes(`Sitemap: ${SITE}sitemap.xml`));
check('the sitemap lists the site', sitemap.includes(`<loc>${SITE}</loc>`));
check(
  'the sitemap has a date the deploy can update',
  /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/.test(sitemap),
);

const ldBlock = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
let ld = null;

try {
  ld = JSON.parse(ldBlock[1]);
} catch {
  ld = null;
}

check('the page describes the game for search engines', Boolean(ld) && ld['@type'] === 'VideoGame');
check(
  'that description names the site',
  Boolean(ld) && ld.url === SITE && ld.image === `${SITE}icons/share.png`,
);
check('the page title names the game', /<title>Diamond Grab[^<]*<\/title>/.test(html));

console.log(failures === 0 ? '\nALL PWA TESTS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
