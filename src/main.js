const { app, BrowserWindow, ipcMain } = require("electron")
const https  = require("https")
const http   = require("http")
const fs     = require("fs")
const path   = require("path")
const os     = require("os")
const { execFile, spawn } = require("child_process")

const OWNER = "ari-labz"

// ── Paths ─────────────────────────────────────────────────────────────────────
// Each component keeps its versions under {base}/{id}/{version}, with {base}/{id}/current.txt
// naming the active one. The GitHub token and protocol cache are shared.

function getBaseDir() {
    if (process.platform === "win32")
        return path.join(process.env.LOCALAPPDATA || os.homedir(), "ARI")
    if (process.platform === "darwin")
        return path.join(os.homedir(), "Library", "Application Support", "ARI")
    return path.join(os.homedir(), ".local", "share", "ARI")
}

const baseDir   = getBaseDir()
const tokenFile = path.join(baseDir, "github_token.txt")
const cacheFile = path.join(baseDir, "protocol-cache.json")
fs.mkdirSync(baseDir, { recursive: true })

// ── Components ─────────────────────────────────────────────────────────────────
// App releases are tagged <prefix><ver> (pre-releases) in the component's own repo.

const COMPONENTS = {
    server: {
        id:           "server",
        label:        "Server",
        repo:         "A.R.I",
        prefix:       "ARI_Server_v",
        // Releases before 0.8.3 were tagged with the prefix; later ones are plain v<ver>. The zip names keep the prefix.
        tagPrefixes:  ["ARI_Server_v", "v"],
        shortcutName: "A.R.I",
        macApp:       "/Applications/A.R.I.app",
        winLauncher:  "ari-launch.cmd",
        startLabel:   "Starting server…",
        // The A·R·I Console (the window that runs and shows the server) bundled inside the version dir.
        // mac: A.R.I.app at the root; win/linux: the Console/ folder with the Electron app.
        findApp(versionDir) {
            if (process.platform === "darwin") {
                const a = path.join(versionDir, "A.R.I.app")
                return fs.existsSync(a) ? a : null
            }
            const consoleDir = path.join(versionDir, "Console")
            if (!fs.existsSync(consoleDir)) return null
            if (process.platform === "win32") {
                const exe = fs.readdirSync(consoleDir).find(f => f.endsWith(".exe") && !/ARI\.Core/i.test(f))
                return exe ? path.join(consoleDir, exe) : null
            }
            const bin = fs.readdirSync(consoleDir, { withFileTypes: true })
                .find(e => e.isFile() && !path.extname(e.name) && !/^ARI\.Core$/i.test(e.name))
            return bin ? path.join(consoleDir, bin.name) : null
        },
        // Fallback when no console is bundled: run the server headless so it at least starts.
        findHeadless(versionDir) {
            if (process.platform === "win32")
                return walkFiles(versionDir).find(f => /ARI(\.Core)?\.exe$/i.test(f))
            if (process.platform === "darwin") {
                const apps = walkDirs(versionDir).filter(d => d.endsWith(".app"))
                if (apps.length) return apps[0]
            }
            return walkFiles(versionDir).find(f => ["ARI.Core", "ARI", "ari"].includes(path.basename(f)))
        },
        // Windows launcher body: runs the active version's console.
        winLaunchLine: dir => `for %%f in ("%BASE%\\%VER%\\Console\\*.exe") do start "" "%%f"\r\n`,
    },
    desktop: {
        id:           "desktop",
        label:        "Desktop",
        repo:         "A.R.I-Desktop",
        prefix:       "ARI_Desktop_v",
        shortcutName: "A.R.I Desktop",
        macApp:       "/Applications/A.R.I Desktop.app",
        winLauncher:  "ari-desktop-launch.cmd",
        startLabel:   "Starting A·R·I Desktop…",
        // The desktop Electron app inside a version dir. mac: the .app; win: the top-level .exe.
        findApp(versionDir) {
            if (process.platform === "darwin") {
                const a = fs.readdirSync(versionDir).find(f => f.endsWith(".app"))
                return a ? path.join(versionDir, a) : null
            }
            if (process.platform === "win32") {
                const exe = fs.readdirSync(versionDir).find(f => f.endsWith(".exe"))
                return exe ? path.join(versionDir, exe) : null
            }
            const bin = fs.readdirSync(versionDir, { withFileTypes: true })
                .find(e => e.isFile() && !path.extname(e.name))
            return bin ? path.join(versionDir, bin.name) : null
        },
        findHeadless: () => null,
        winLaunchLine: dir => `for %%f in ("%BASE%\\%VER%\\*.exe") do start "" "%%f"\r\n`,
    },
}

for (const c of Object.values(COMPONENTS)) {
    c.dir         = path.join(baseDir, c.id)
    c.currentFile = path.join(c.dir, "current.txt")
    fs.mkdirSync(c.dir, { recursive: true })
}

function component(id) {
    const c = COMPONENTS[id]
    if (!c) throw new Error(`Unknown component "${id}".`)
    return c
}

const tagPrefixOf = (c, tag) => (c.tagPrefixes ?? [c.prefix]).find(p => tag.startsWith(p))
const verFromTag  = (c, tag) => tag.slice(tagPrefixOf(c, tag).length)

// ── Window ────────────────────────────────────────────────────────────────────

let win

app.whenReady().then(() => {
    win = new BrowserWindow({
        width: 460,
        height: 500,
        resizable: false,
        titleBarStyle: "hidden",
        trafficLightPosition: { x: 16, y: 16 },
        backgroundColor: "#1b2e38",
        icon: path.join(__dirname, "..", "assets", "icon.png"),
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
        },
    })
    win.loadFile(path.join(__dirname, "index.html"))
})

app.on("window-all-closed", () => app.quit())

// ── IPC: token ────────────────────────────────────────────────────────────────

ipcMain.handle("get-platform", () => process.platform)

// Probe each component's releases endpoint anonymously. If GitHub returns 401/404 the repo
// is private and a token is required; otherwise it's public and we skip the token screen.
ipcMain.handle("needs-token", async () => {
    const results = await Promise.all(Object.values(COMPONENTS).map(async c => {
        try {
            const data = await ghJson(null, `/repos/${OWNER}/${c.repo}/releases?per_page=1`)
            return !Array.isArray(data)
        } catch {
            return true
        }
    }))
    return results.some(Boolean)
})

ipcMain.handle("get-token", () => {
    // A token the user saved here wins over an ambient GITHUB_TOKEN env var, so re-entering a
    // valid token sticks even on a machine where the env var holds a stale/wrong one.
    if (fs.existsSync(tokenFile)) {
        const t = fs.readFileSync(tokenFile, "utf8").trim()
        if (t) return t
    }
    const env = process.env.GITHUB_TOKEN
    if (env?.trim()) return env.trim()
    return null
})

ipcMain.handle("save-token", (_, token) => {
    fs.writeFileSync(tokenFile, token.trim(), "utf8")
})

// ── IPC: releases + protocol ────────────────────────────────────────────────────

ipcMain.handle("fetch-releases", async (_, id, token) => {
    const c = component(id)
    const releases = await ghJson(token, `/repos/${OWNER}/${c.repo}/releases?per_page=100`)
    if (!Array.isArray(releases) || releases.length === 0)
        throw new Error("No releases found on GitHub.")

    const list = releases
        .filter(r => !r.draft && tagPrefixOf(c, r.tag_name))
        .sort((a, b) => compareVersions(verFromTag(c, b.tag_name), verFromTag(c, a.tag_name)))
        .map(r => ({
            tagName:    r.tag_name,
            version:    verFromTag(c, r.tag_name),
            prerelease: r.prerelease,
            assets:     r.assets.map(a => ({ id: a.id, name: a.name })),
        }))

    // Resolve each version's protocol (cached — a tag's manifest never changes).
    const cache = readCache()
    await Promise.all(list.map(async r => {
        const key = `${c.id}:${r.tagName}`
        if (cache[key] === undefined)
            cache[key] = await fetchProtocol(c, token, r.tagName)
        r.protocol = cache[key]
    }))
    writeCache(cache)

    return list
})

// Reads manifest.json ({ "version": "..", "protocol": N }) committed at the tag.
async function fetchProtocol(c, token, tag) {
    try {
        const res = await ghJson(token, `/repos/${OWNER}/${c.repo}/contents/manifest.json?ref=${encodeURIComponent(tag)}`)
        if (!res?.content) return null
        const json = JSON.parse(Buffer.from(res.content, "base64").toString("utf8"))
        return Number.isInteger(json.protocol) ? json.protocol : null
    } catch {
        return null   // older releases may predate the manifest
    }
}

// ── IPC: installed state ────────────────────────────────────────────────────────

ipcMain.handle("installed-info", (_, id) => {
    const c = component(id)
    const version = installedVersion(c)
    if (!version) return null
    return { version, protocol: bundledProtocol(c, version) }
})

function installedVersion(c) {
    if (fs.existsSync(c.currentFile)) {
        const v = fs.readFileSync(c.currentFile, "utf8").trim()
        if (v && fs.existsSync(path.join(c.dir, v))) return v
    }
    const dirs = installedVersionDirs(c)
    return dirs.length ? dirs[0].name : null
}

function installedVersionDirs(c) {
    return fs.readdirSync(c.dir)
        .map(n => ({ name: n, full: path.join(c.dir, n) }))
        .filter(d => /^\d+\.\d+\.\d+/.test(d.name) && fs.statSync(d.full).isDirectory())
        .sort((a, b) => compareVersions(b.name, a.name))
}

// Reads the manifest.json bundled inside an installed version dir.
function bundledProtocol(c, version) {
    try {
        const p = path.join(c.dir, version, "manifest.json")
        if (!fs.existsSync(p)) return null
        const json = JSON.parse(fs.readFileSync(p, "utf8"))
        return Number.isInteger(json.protocol) ? json.protocol : null
    } catch {
        return null
    }
}

// ── IPC: install + launch ────────────────────────────────────────────────────────

ipcMain.handle("download-and-install", async (event, id, token, release, options) => {
    const c         = component(id)
    const ver       = release.version
    const assetName = getAssetName(c, ver)
    const asset     = release.assets.find(a => a.name === assetName)
    if (!asset) {
        const names = release.assets.map(a => a.name).join(", ")
        throw new Error(`Asset "${assetName}" not in release. Available: ${names || "none"}`)
    }

    const zipPath    = path.join(os.tmpdir(), asset.name)
    const versionDir = path.join(c.dir, ver)
    fs.mkdirSync(versionDir, { recursive: true })

    await downloadAsset(c, token, asset.id, zipPath, (pct, received, total) => {
        event.sender.send("download-progress", { pct, received, total })
    })

    event.sender.send("status", "Extracting…")
    await extract(zipPath, versionDir)
    fs.rmSync(zipPath, { force: true })
    if (process.platform !== "win32") setExecutableBit(versionDir)

    // Record the protocol locally so installed-info never depends on the zip's
    // contents. Prefer a manifest shipped in the release; fall back to the value
    // resolved from GitHub when the list was fetched.
    if (!fs.existsSync(path.join(versionDir, "manifest.json")) && Number.isInteger(release.protocol)) {
        const manifest = { version: ver, protocol: release.protocol }
        fs.writeFileSync(path.join(versionDir, "manifest.json"), JSON.stringify(manifest), "utf8")
    }

    fs.writeFileSync(c.currentFile, ver, "utf8")
    cleanOldVersions(c, ver)

    if (options?.addShortcut || options?.addDesktop || options?.addDock) {
        event.sender.send("status", "Adding shortcuts…")
        try { await addShortcut(c, versionDir, options) } catch (e) { /* best-effort */ }
    }
    if (options?.start) {
        event.sender.send("status", c.startLabel)
        try { launch(c, versionDir) } catch (e) { /* best-effort */ }
    }
    return { version: ver, protocol: bundledProtocol(c, ver) }
})

ipcMain.handle("launch", (_, id, version) => {
    const c   = component(id)
    const v   = version || installedVersion(c)
    const dir = v ? path.join(c.dir, v) : null
    if (!dir || !fs.existsSync(dir)) throw new Error("No installed version to launch.")
    launch(c, dir)
})

function launch(c, versionDir) {
    const target = c.findApp(versionDir)
    if (target) {
        if (process.platform === "darwin") spawn("open", [target], { detached: true }).unref()
        else spawn(target, [], { detached: true, stdio: "ignore" }).unref()
        return
    }
    const exe = c.findHeadless(versionDir)
    if (!exe) throw new Error(`Could not find the ARI ${c.label} app in ${versionDir}`)
    const opts = { detached: true, stdio: "ignore", env: { ...process.env, APP_INSTALL_ROOT: versionDir } }
    if (process.platform === "darwin" && exe.endsWith(".app")) spawn("open", [exe], opts).unref()
    else spawn(exe, [], opts).unref()
}

// ── Helpers: GitHub ─────────────────────────────────────────────────────────────

function ghHeaders(token, accept) {
    const headers = {
        "User-Agent":           "ARIInstaller/2.0",
        "X-GitHub-Api-Version": "2022-11-28",
        "Accept":               accept || "application/vnd.github+json",
    }
    if (token) headers["Authorization"] = `token ${token}`
    return headers
}

function ghJson(token, apiPath) {
    return new Promise((resolve, reject) => {
        https.get({ hostname: "api.github.com", path: apiPath, headers: ghHeaders(token) }, res => {
            let data = ""
            res.on("data", c => data += c)
            res.on("end", () => {
                if (res.statusCode === 401 || res.statusCode === 403) return reject(new Error("TOKEN_INVALID"))
                if (res.statusCode === 404) return reject(new Error("NOT_FOUND"))
                if (res.statusCode !== 200) return reject(new Error(`GitHub API returned ${res.statusCode}`))
                try { resolve(JSON.parse(data)) }
                catch { reject(new Error("Failed to parse GitHub response.")) }
            })
        }).on("error", reject)
    })
}

function downloadAsset(c, token, assetId, destPath, onProgress) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: "api.github.com",
            path: `/repos/${OWNER}/${c.repo}/releases/assets/${assetId}`,
            headers: ghHeaders(token, "application/octet-stream"),
        }
        function doGet(url, redirectCount = 0) {
            if (redirectCount > 5) return reject(new Error("Too many redirects"))
            const mod     = url?.startsWith("http://") ? http : https
            const reqOpts = url ? new URL(url) : opts
            mod.get(reqOpts, res => {
                if ([301, 302, 307, 308].includes(res.statusCode))
                    return doGet(res.headers.location, redirectCount + 1)
                if (res.statusCode !== 200)
                    return reject(new Error(`Download failed: ${res.statusCode}`))
                const total  = parseInt(res.headers["content-length"] || "0", 10)
                let received = 0
                const dest   = fs.createWriteStream(destPath)
                res.on("data", chunk => {
                    received += chunk.length
                    dest.write(chunk)
                    if (total > 0) onProgress(Math.floor(received * 100 / total), received, total)
                })
                res.on("end",   () => { dest.end(); resolve() })
                res.on("error", e  => { dest.destroy(); reject(e) })
            }).on("error", reject)
        }
        doGet(null)
    })
}

// ── Helpers: filesystem / versions ───────────────────────────────────────────────

// Compare "v0.4.0" vs "v0.3.4" numerically. Returns >0 if a is newer.
function compareVersions(a, b) {
    const parse = t => String(t).replace(/^v/i, "").split(/[.\-+]/).map(n => parseInt(n, 10) || 0)
    const pa = parse(a), pb = parse(b)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0)
        if (d !== 0) return d
    }
    return 0
}

function getAssetName(c, version) {
    const plat = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux"
    return `${c.prefix}${version}_${plat}.zip`
}

function extract(zipPath, destDir) {
    return new Promise((resolve, reject) => {
        if (process.platform === "win32") {
            const ps = `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`
            execFile("powershell.exe", ["-NoProfile", "-Command", ps], err => err ? reject(err) : resolve())
        } else {
            execFile("unzip", ["-o", zipPath, "-d", destDir], err => err ? reject(err) : resolve())
        }
    })
}

function setExecutableBit(dir) {
    for (const f of walkFiles(dir)) {
        const name = path.basename(f)
        if (name === "ARI.Core" || name === "ARI" || name === "ari" || !path.extname(f)) {
            try { fs.chmodSync(f, 0o755) } catch {}
        }
    }
}

function cleanOldVersions(c, keepVersion) {
    // Keep the 3 newest installed versions so downgrade stays fast.
    for (const d of installedVersionDirs(c).slice(3)) {
        if (d.name === keepVersion) continue
        try { fs.rmSync(d.full, { recursive: true, force: true }) } catch {}
    }
}

function* walkFiles(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) yield* walkFiles(full)
        else yield full
    }
}

function* walkDirs(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) { yield full; yield* walkDirs(full) }
    }
}

function readCache() {
    try { return JSON.parse(fs.readFileSync(cacheFile, "utf8")) } catch { return {} }
}
function writeCache(cache) {
    try { fs.writeFileSync(cacheFile, JSON.stringify(cache), "utf8") } catch {}
}

// ── Helpers: OS shortcuts ────────────────────────────────────────────────────────

function logInstaller(line) {
    try { fs.appendFileSync(path.join(baseDir, "installer.log"), `${line}\n`) } catch {}
}

async function addShortcut(c, versionDir, options = {}) {
    if (process.platform === "darwin") {
        // The Desktop alias and Dock entry both point at the /Applications app, so make sure it is
        // placed whenever any of the three mac options is selected.
        if (options.addShortcut || options.addDesktop || options.addDock) await placeMacApp(c, versionDir)
        if (options.addDesktop) await addMacDesktopAlias(c)
        if (options.addDock)    await addMacDock(c)
    } else if (process.platform === "win32") {
        const launcher = createWinLauncher(c)
        if (options.addShortcut) await createWinShortcut(c, launcher, "Programs")
        if (options.addDesktop)  await createWinShortcut(c, launcher, "Desktop")
    }
}

// macOS: copy the component's app into /Applications. The server's console reads current.txt at
// launch, so placing it once is enough. Writing to /Applications needs a single admin authorization.
function placeMacApp(c, versionDir) {
    const bundled = c.findApp(versionDir)
    if (!bundled) return Promise.resolve()   // nothing to place in this build
    return new Promise(resolve => {
        const shell = `rm -rf '${c.macApp}' && cp -R '${bundled}' '${c.macApp}'`
        const osa   = `do shell script "${shell.replace(/"/g, '\\"')}" with administrator privileges`
        execFile("osascript", ["-e", osa], () => resolve())
    })
}

// Windows: a small launcher .cmd that resolves the active version via current.txt, so the
// Start Menu shortcut pointing at it survives updates/downgrades.
function createWinLauncher(c) {
    const cmd = path.join(baseDir, c.winLauncher)
    fs.writeFileSync(cmd,
        `@echo off\r\n` +
        `set "BASE=${c.dir}"\r\n` +
        `set /p VER=<"%BASE%\\current.txt"\r\n` +
        c.winLaunchLine())
    return cmd
}

// Creates a .lnk in a Windows special folder ('Programs' = Start Menu, 'Desktop') pointing at the
// version-agnostic launcher. The folder is resolved inside PowerShell via GetFolderPath so
// OneDrive-redirected Desktops and roaming Start Menus are handled. Awaited (so an early window
// close can't kill it mid-write) and the outcome is always written to installer.log.
function createWinShortcut(c, target, folder) {
    const psExe = path.join(process.env.SystemRoot || "C:\\Windows",
        "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    const ps = [
        `$ErrorActionPreference='Stop';`,
        `try {`,
        `  $dir=[Environment]::GetFolderPath('${folder}');`,
        `  $lnk=Join-Path $dir '${c.shortcutName}.lnk';`,
        `  $WS=New-Object -ComObject WScript.Shell;`,
        `  $s=$WS.CreateShortcut($lnk);`,
        `  $s.TargetPath='${target}';`,
        `  $s.WorkingDirectory='${path.dirname(target)}';`,
        `  $s.Save();`,
        `  Write-Output ('created '+$lnk)`,
        `} catch { Write-Output ('ERROR '+$_.Exception.Message); exit 1 }`,
    ].join(" ")
    return new Promise(resolve => {
        execFile(psExe, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], (err, stdout, stderr) => {
            logInstaller(`[shortcut ${c.id} ${folder}] ${(stdout || "").trim()}` +
                `${err ? " err=" + err.message : ""}${stderr && stderr.trim() ? " stderr=" + stderr.trim() : ""}`)
            resolve()
        })
    })
}

// macOS: a Desktop alias (symlink) to the /Applications app.
function addMacDesktopAlias(c) {
    return new Promise(resolve => {
        const link = path.join(os.homedir(), "Desktop", path.basename(c.macApp))
        try { fs.rmSync(link, { recursive: true, force: true }) } catch {}
        try { fs.symlinkSync(c.macApp, link) } catch (e) { logInstaller(`[desktop-alias ${c.id}] ${e.message}`) }
        resolve()
    })
}

// macOS: add the /Applications app to the Dock (persistent-apps) and restart the Dock so it shows.
function addMacDock(c) {
    return new Promise(resolve => {
        const tile = `<dict><key>tile-data</key><dict><key>file-data</key><dict>` +
                     `<key>_CFURLString</key><string>${c.macApp}</string>` +
                     `<key>_CFURLStringType</key><integer>0</integer></dict></dict></dict>`
        execFile("defaults", ["write", "com.apple.dock", "persistent-apps", "-array-add", tile], err => {
            if (err) { logInstaller(`[dock ${c.id}] ${err.message}`); return resolve() }
            execFile("killall", ["Dock"], () => resolve())
        })
    })
}
