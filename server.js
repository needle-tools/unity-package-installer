// server.js
// where your node app starts

// we've started you off with Express (https://expressjs.com/)
// but feel free to use whatever libraries or frameworks you'd like through `package.json`.
const express = require("express");
const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const targz = require('targz');
const semver = require('semver');
const rimraf = require("rimraf");
const nanoid = require('nanoid');
const fetch = require('node-fetch');

const stats  = require("./stats");

const app = express(); 

// make all the files in 'public' available
// https://expressjs.com/en/starter/static-files.html
app.use(express.static("public")); 

stats.setupApp(app);

// https://expressjs.com/en/starter/basic-routing.html
app.get("/", (request, response) => {
  response.sendFile(__dirname + "/views/index.html");
});
 

// https://expressjs.com/en/starter/basic-routing.html


function getDirectories(path) {
  return fs.readdirSync(path).filter(function (file) {
    return fs.statSync(path+'/'+file).isDirectory();
  });
}
            
// https://stackoverflow.com/a/56119188
// decompress files from tar.gz archive
function decompressPromise(file, tmpPath) {
  return new Promise((resolve, reject) => {
  targz.decompress({
    src: file,
    dest: tmpPath
  }, function(err){
      if(err) {
          console.log(err);
          reject(err);
      } else {
          // console.log("Done decompressing!");
          resolve(tmpPath);
      }
  })
})};

function compressPromise(tmpPath, tmpFile) {
    return new Promise((resolve, reject) => {
      // compress files into tar.gz archive
        targz.compress({
            src: tmpPath,
            dest: tmpFile
        }, function(err){
            if(err) {
              reject(err);
                console.log(err);
            } else {
                // console.log("Done compressing!");
                resolve(tmpFile);
            }
        });
    });
  }

app.get("/test/:registry/:nameAtVersion", async (request, response, next) => {
  let packages = [];
  
  // response.json(request.query);
  let parts0 = request.params.nameAtVersion.split(',');
  for(let key in parts0) {
    let tuple = splitNameAndVersion(parts0[key]);
    
    if(!tuple) {
      response.status(500).send({ error: 'Please use the format com.my.package@1.0.0 with a valid semver.' });
      return;
    }
    
    packages.push({
      name: tuple.name,
      version: tuple.version,
      installType: 1
    });
  }
  
  response.json(packages);
});

function removeCredentialsTools(tmpPath) {
  // remove directories we don't need right now,
  // e.g. everything related to credentials handling.
  let credentialsFiles = [
    "52218f1b260be3045a4293f1ebc40b18", // AutoInstaller.Tomlyn.dll 
    "d7a51e69373973d458e0da95b391295f", // LICENSE.Tomlyn.md
    "d7dd0223250a92244a276c6129a21f40", // NPM.cs
    "d9a1dbfef6b8e6645b0358fd82179d8a", // CredentialManager.cs
    "4c8f6c9394ae4494998e1fc19268e959", // CredentialWindow.cs
  ];
  for(let d in credentialsFiles) {
    let dirName = tmpPath + "/" + credentialsFiles[d];
    if(fs.existsSync(dirName))
      // fs.rmdirSync(dirName, { recursive: true });
      rimraf.sync(dirName);
    else
      console.log("directory does not exist, can't remove: " + dirName);
  }
}

function modifyPackagePath(tmpPath, packageName) {
  // Modify all paths to make this a unique installer
  // get all directories
  let dirs = getDirectories(tmpPath);
  // console.log(dirs);
  
  let newPackageName = "Packages/installer." + packageName + "/";
  
  // in each directory
  for(var d in dirs) {
    let dir = dirs[d];
    let pathnamePath = tmpPath + "/" + dir + "/pathname";
    // - open the single line in the file "path"
    let pathData = fs.readFileSync(pathnamePath, 'utf8');
    // console.log("in dir: " + dirs[d] + ": " + pathData);
    // - change the path prefix to a common one for this installer
    pathData = pathData.replace("Packages/com.needle.auto-installer/", newPackageName); 
    // - write the "path" file again
    fs.writeFileSync(pathnamePath, pathData, 'utf8');
  }
}

function splitNameAndVersion(nameAndVersion) {
  let parts = nameAndVersion.split('@');
  if(parts.length < 1 || parts.length > 2)
    return false;
  
  let name = parts[0];
  let version = parts.length == 2 ? parts[1] : "";
  
  if(version === "latest")
    version = "";
  
  if(version != null && version != "")
    if(!semver.valid(version))
      return false;
  
  if(version == "")
    version = "latest";
  
  return { name: name, version: version };
}
  
// https://dev.to/isalevine/three-ways-to-retrieve-json-from-the-web-using-node-js-3c88
function checkPackageExistance(url) {
  console.log("checking existance of " + url);
  return fetch(url, { method: "Get" })
  .then(response => response.json())
  .then(json => {
    // log fetch response
    // console.log(json);
    return json;
  })
  .catch(error => {
    return { error: error };
  });
}

// http://package-installer.glitch.me/v1/install/needle/com.needle.compilation-visualizer/1.0.0?registry=https://packages.needle.tools&scope=com.needle
// http://package-installer.glitch.me/v1/install/OpenUPM/elzach.leveleditor/0.0.7?registry=https://package.openupm.com&scope=elzach.leveleditor&scope=elzach.extensions

// Server-side cache for the "what's new" feed so we fetch it at most once per
// TTL and inline the chosen card into the page. This makes the advert reliable
// on the very first page load (no client fetch that can fail/be blocked).
const WHATS_NEW_URL = "https://marketer.needle.tools/api/whats-new?surface=package-installer&license=none&limit=20";
const WHATS_NEW_TTL = 5 * 60 * 1000; // 5 minutes
let whatsNewCache = { items: null, at: 0 };

async function getWhatsNewItems() {
  const now = Date.now();
  if (whatsNewCache.items && (now - whatsNewCache.at) < WHATS_NEW_TTL)
    return whatsNewCache.items;

  try {
    const res = await fetch(WHATS_NEW_URL);
    const data = await res.json();
    const items = (data && data.items) || [];
    whatsNewCache = { items: items, at: now };
    return items;
  } catch (e) {
    console.log("Failed to fetch what's new feed: " + e.toString());
    // serve stale cache if we have it, otherwise show no advert
    return whatsNewCache.items || [];
  }
}

// Pick one item at random, weighted by priority (higher priority = more likely).
// priority+1 keeps zero-priority items in the running.
function pickWeightedItem(items) {
  let total = 0;
  for (const item of items) total += (item.priority || 0) + 1;
  let r = Math.random() * total;
  for (const item of items) {
    r -= (item.priority || 0) + 1;
    if (r < 0) return item;
  }
  return items[items.length - 1];
}

// Pick dark/light foreground for a hex background by its luminance.
function readableTextColor(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum >= 0.6 ? "#111" : "#fff";
}

// Build the inlined "what's new" card HTML for a feed item.
// Returns { html, id, title } so the page can also emit tracking for it.
function renderWhatsNewCard(item, esc) {
  const banner = item.banner || {};
  const short = item.short || {};
  const title = banner.title || short.title || "";
  const subtitle = banner.subtitle || short.description || "";
  const cta = banner.cta || "Learn more";
  const url = item.url || "#";

  // Theme from the authored brand colours; otherwise the CSS default
  // (.whats-new-card) themes it from the site palette.
  let style = "";
  const colors = (item.colors || []).filter(Boolean);
  if (colors.length) {
    const bg = colors.length >= 2
      ? `linear-gradient(135deg, ${colors[0]}, ${colors[1]})`
      : colors[0];
    let css = `background:${bg};`;
    const fg = readableTextColor(colors[0]);
    if (fg) css += `color:${fg};`;
    style = ` style="${esc(css)}"`;
  }

  const media = (item.media || []).filter((m) => m && m.type === "image" && m.url);
  const wide = media.find((m) => m.format === "wide") || media[0];
  const imgHtml = wide ? `<img src="${esc(wide.url)}" alt="">\n        ` : "";

  const html = `<a id="whatsNewCard" class="whats-new-card" href="${esc(url)}" target="_blank" rel="noopener"${style}>
        ${imgHtml}<span class="whats-new-title">${esc(title)}</span>
        <span class="whats-new-subtitle">${esc(subtitle)}</span>
        <span class="whats-new-cta">${esc(cta)}</span>
      </a>`;

  return { html, id: item.id || "", title };
}

/**
 * Render the small "post download" page that auto-starts the actual download
 * (same installer URL with ?dl=1) and shows a Needle "what's new" advert that
 * is fetched + cached server-side and inlined into the page.
 * @param {import("express").Request} request
 */
async function renderDownloadPage(request) {
  // same URL, but pointing at the real file (?dl=1)
  const original = request.originalUrl;
  const downloadUrl = original + (original.includes("?") ? "&" : "?") + "dl=1";

  // friendly package name for display (strip @version if present)
  const nameVersion = splitNameAndVersion(request.params.nameAtVersion);
  const packageName = nameVersion ? nameVersion.name : request.params.nameAtVersion;

  // basic HTML escaping for the few server-injected values
  const esc = (str) => String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);

  // fetch (cached) feed, pick a weighted-random hero, and inline its card
  const items = await getWhatsNewItems();
  const hero = items.length ? pickWeightedItem(items) : null;
  const card = hero ? renderWhatsNewCard(hero, esc) : null;

  const whatsNewHtml = card ? `
  <div id="whatsNew" class="whats-new">
    <span class="whats-new-eyebrow">What's new at Needle</span>
    <div id="whatsNewList">${card.html}</div>
  </div>` : "";

  const whatsNewTracking = card ? `
    var heroEl = document.getElementById('whatsNewCard');
    if (heroEl) {
      track('whatsnew_impression', ${JSON.stringify({ id: card.id, title: card.title })});
      heroEl.addEventListener('click', function () {
        track('whatsnew_click', ${JSON.stringify({ id: card.id, title: card.title, url: hero.url || "" })});
      });
    }` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>🌵 Downloading ${esc(packageName)} — needle</title>
  <link rel="icon" href="/favicon.ico" type="image/x-icon">
  <link rel="stylesheet" href="/style.css">
  <script src="https://analytics-2.needle.tools/api/script.js" data-site-id="4d65f5b89a8d" defer></script>
</head>
<body class="download-page">
  <a href="https://needle.tools">
    <img src="/needle-logo-black.svg" alt="Needle Logo" class="logo">
  </a>

  <h1>Your download is starting…</h1>
  <p>
    Installer for <strong>${esc(packageName)}</strong> should download automatically.<br>
    If it doesn't, <a id="manualDownload" href="${esc(downloadUrl)}">click here to download it</a>.
  </p>
${whatsNewHtml}
  <!-- triggers the actual file download without navigating away -->
  <iframe src="${esc(downloadUrl)}" style="display:none" title="download"></iframe>

  <script>
    var PACKAGE = ${JSON.stringify(packageName)};

    // Best-effort custom event tracking (Rybbit). No-op if the script blocked.
    function track(name, props) {
      try { if (window.rybbit && window.rybbit.event) window.rybbit.event(name, props || {}); } catch (e) {}
    }

    // Manual fallback link click means the auto-download likely didn't fire.
    var manual = document.getElementById('manualDownload');
    if (manual) manual.addEventListener('click', function () {
      track('download_manual', { package: PACKAGE });
    });
${whatsNewTracking}
  </script>

  <p class="download-back">
    <a href="/">
      <svg class="back-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <line x1="19" y1="12" x2="5" y2="12"></line>
        <polyline points="12 19 5 12 12 5"></polyline>
      </svg>
      Create another package installer
    </a>
  </p>
</body>
</html>`;
}

// https://stackoverflow.com/questions/41941724/nodejs-sendfile-with-file-name-in-download
// send the .unitypackage back
// https://techeplanet.com/express-path-parameter/
app.get("/v1/installer/:registry/:nameAtVersion", /** @returns {Promise<any>} */ async (request, response, next) => {

  // When a human navigates to an installer link we first show a small
  // "post download" page that kicks off the actual download (same URL with
  // ?dl=1) and shows a Needle "what's new" hint. The ?dl=1 request below
  // does the real work and streams the .unitypackage.
  if (!request.query.dl) {
    return response.send(await renderDownloadPage(request));
  }

  console.log(request.query.scope + " - " + request.params.nameAtVersion);
  console.log(request.query.registry);
  
  const registryName = request.params.registry;
  
  const nameVersion = splitNameAndVersion(request.params.nameAtVersion);
  if(!nameVersion) {
    sendAnalyticsEvent({
      request: request,
      name: "error",
      props: {
        packageName: request.params.nameAtVersion,
        packageVersion: "",
        registryName: registryName,
        registryUrl: request.query.registry?.toString() || "no-registry",
        error: 'Please use the format com.my.package@1.0.0 with a valid semver.'
      }
    });
    return response.status(500).send({ error: 'Please use the format com.my.package@1.0.0 with a valid semver.' });
  }
  
  let packageName = nameVersion.name;
  let packageVersion = nameVersion.version;
  
  let registryUrl = request.query.registry?.toString();
  if(typeof registryUrl === "string") registryUrl = registryUrl.replace(/(\r\n|\n|\r)/gm,"");
  
  // try to download package details from registry; check if the package even exists before creating an installer for it.
  let existanceResult = await checkPackageExistance(registryUrl + "/" + packageName); //  + "/" + packageVersion 
  // console.log("version check result: ", existanceResult);
  
  if(typeof existanceResult.error !== 'undefined') {
    sendAnalyticsEvent({
      request: request,
      name: "error",
      props: {
        packageName: packageName,
        packageVersion: packageVersion,
        registryName: registryName,
        registryUrl: registryUrl?.toString() || "no-registry",
        error: existanceResult.error.toString(),
      }
    })
    // TODO we probably want to allow creating installers for packages that need auth.
    // Someone using the installer might have auth in place.
    
    // console.log("BAD BAD ERROR " + existanceResult.error);
    response.status(500).send({ error: existanceResult.error });
    return;
  }
  
  // if we got here, the package exists, is accessible, and ready to be downloaded
  // let's use the correct latest version if none was specified
  // console.log("Package has version online: ", existanceResult.version);
  if(!semver.valid(packageVersion) && semver.valid(existanceResult.version))
    packageVersion = existanceResult.version;
  
  
  let registryScope = request.query.scope;
  if(!Array.isArray(registryScope)) registryScope = [ /**@type {string}*/(registryScope) ];
  
  // if scope is not defined we fall back to package name as scope.
  // TODO could add a better heuristic here to walk the scope, avoid collisions with unity scopes, and use that instead
  // as it would result in dependencies (probably) working.
  if(typeof registryScope === 'undefined' || registryScope == "") {
    registryScope = [ packageName ];
    let dependencies = existanceResult.dependencies;
    if(typeof dependencies == 'undefined' && existanceResult.versions) {
      var keys = Object.keys(existanceResult.versions);
      var last = keys[keys.length - 1];
      var lastVersion = existanceResult.versions[last];
      // console.log(lastVersion.version, lastVersion.dependencies);
      dependencies = lastVersion.dependencies;
    }
    
    if(typeof dependencies !== 'undefined') {
      // filter out only the ones that are NOT from unity
      for(var dep in dependencies) {
        if(!dep.startsWith("com.unity"))
          registryScope.push(dep);
      }
      console.log("used dependency scope: " + registryScope);
    }
    else {
      console.log("used fallback scope: " + registryScope)
    }
  }
  
  // input file - this needs to be updated via Git import
  // so that it lives directly next to the files here.
  // this is a renamed .unitypackage file (which is just a .tar.gz)
  // CAREFUL - selecting the file in the glitch UI will weirdly convert it to some text format?! DO NOT TOUCH this file through the Glitch UI
  const file = __dirname + "/DO-NOT-TOUCH/" + "archtemp.tar.gz";
  
  // generate temporary paths to unpack/pack the archive file
  const salt = nanoid.nanoid() + "_" + Date.now();
  const tmpPath = path.resolve(process.cwd(), './.tmp/my_package_folder_' + salt);
  const tmpFile = tmpPath + '.tar.gz';
  fs.ensureDir(tmpPath);
  const targetPath = await decompressPromise(file, tmpPath);
  
  /// MODIFY PACKAGE CONTENT
  
  removeCredentialsTools(tmpPath);  
  modifyPackagePath(tmpPath, packageName);
  
  // Modify PackageData.asset:
  const dataGuid = "54e893365203989479ba056e0bf3174a";
  const assetFile = tmpPath + "/" + dataGuid + "/" + "asset";
  const data = fs.readFileSync(assetFile, 'utf8');
  
  // we need to split the original file into parts
  // since Unity's YAML format is not spec conform.
  // we split off the header, and treat the rest as valid yaml.
  // Note: There's probably a way to configure the yaml parser to accept the Unity headers
  const splitLines = str => str.split(/\r?\n/);
  const split_lines = splitLines(data);
  
  const some_lines = split_lines.slice(3);  
  const startWithBrokenYamlTag = split_lines.slice(0, 3).join("\n");
  
  const yamlData = yaml.load(some_lines.join("\n"));

  yamlData["MonoBehaviour"]["registries"] = [{
    name: registryName,
    url: registryUrl,
    scope: registryScope
  }];
  
  yamlData["MonoBehaviour"]["packages"] = [{
    name: packageName,
    version: packageVersion,
    installType: 1
  }];
  
  // lineWidth param is necessary, otherwise long registry names break in weird >- yaml multiline, which Unity does not (properly?) support.
  const combinedFile = startWithBrokenYamlTag + "\n" + yaml.dump(yamlData, { lineWidth: 500 });
  
  fs.writeFileSync(assetFile, combinedFile, 'utf8')
  
  /// END MODIFY PACKAGE CONTENT  
  
  // pack into a .tar.gz again
  const compressPath = await compressPromise(tmpPath, tmpFile);  
  
  stats.register({name:packageName, version:packageVersion, request:request})
  
  // serve as .unitypackage with a nice name related to the package name and version.
  response.download(compressPath, "Install-" + packageName + "-" + packageVersion + ".unitypackage");

  sendAnalyticsEvent({
    request: request,
    name: "download",
    props: {
      packageName: packageName,
      packageVersion: packageVersion,
      registryName: registryName,
      registryUrl: registryUrl?.toString() || "no-registry",
      scope: Array.isArray(registryScope) ? registryScope.join(",") : registryScope
    }
  })
});

// listen for requests :)
const port = process.env.PORT || 3017;
const listener = app.listen(port, () => {
  console.log("Your app is listening on port http://localhost:" + listener.address().port);
});


/**
 * Get the IP address of the request.
 * @param {Object} request - The HTTP request object.
 */
function getIpAddress(request) {
  return request.headers['cf-connecting-ip'] || 
         (request.headers['x-forwarded-for'] && request.headers['x-forwarded-for'].split(',')[0].trim()) ||
         request.headers['x-real-ip'] ||
         request.connection.remoteAddress ||
         request.socket.remoteAddress ||
         request.ip;
}


/**
 * Send an analytics event.
 * @param {{request:import("express").Request, name:string, props:Record<string, string>}} args - The arguments for the event.
 */
function sendAnalyticsEvent(args) {

  const ipAddress = getIpAddress(args.request);

  // split the request URL into pathname + querystring for Rybbit
  const originalUrl = args.request.originalUrl || "/";
  const qIndex = originalUrl.indexOf("?");
  const pathname = qIndex === -1 ? originalUrl : originalUrl.slice(0, qIndex);
  const querystring = qIndex === -1 ? "" : originalUrl.slice(qIndex);

  const headers = { 'Content-Type': 'application/json' };
  // Authorization is optional but recommended for server-side tracking.
  if (process.env.RYBBIT_API_KEY) headers["Authorization"] = "Bearer " + process.env.RYBBIT_API_KEY;

  const url = "https://analytics-2.needle.tools/api/track";
  console.log("Sending analytics event to " + url + " for " + args.request.originalUrl);
  return fetch(url, {
    method: "POST",
    headers: headers,
    body: JSON.stringify({
      site_id: "4d65f5b89a8d",
      type: "custom_event",
      event_name: args.name,
      hostname: "package-installer.needle.tools",
      pathname: pathname,
      querystring: querystring,
      referrer: args.request.headers.referer || "",
      user_agent: args.request.headers['user-agent'] || "unknown",
      ip_address: ipAddress,
      // properties must be a JSON-encoded string for the Rybbit API
      properties: JSON.stringify({ ...args.props }),
    })
  });
}