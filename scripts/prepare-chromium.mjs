// Menyiapkan Chromium milik Playwright agar ikut dibundel ke installer
// (electron-builder extraResources: vendor/chromium -> resources/chromium).
// Dijalankan di OS yang sama dengan target build (Windows untuk .exe,
// Linux untuk .deb/.rpm), karena binary Chromium berbeda tiap OS.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const downloadDir = path.join(root, "vendor", "pw-browsers");
const outputDir = path.join(root, "vendor", "chromium");

fs.rmSync(downloadDir, { recursive: true, force: true });
fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(downloadDir, { recursive: true });

console.log("Mengunduh Chromium Playwright ke", downloadDir);
const playwrightPkg = require.resolve("playwright/package.json");
const playwrightCli = path.join(path.dirname(playwrightPkg), "cli.js");

execFileSync(
  process.execPath,
  [playwrightCli, "install", "--no-shell", "chromium"],
  {
    stdio: "inherit",
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: downloadDir },
  },
);

const revisionDir = fs
  .readdirSync(downloadDir)
  .find((name) => name.startsWith("chromium-") && !name.includes("headless"));
if (!revisionDir) {
  throw new Error(`Folder chromium-<revisi> tidak ditemukan di ${downloadDir}`);
}

fs.cpSync(path.join(downloadDir, revisionDir), outputDir, { recursive: true });

// Cari executable dan pastikan lokasinya sesuai yang dicari aplikasi
// (lihat findBundledChromium di desktop/services/automation.js).
const exeName = process.platform === "win32" ? "chrome.exe" : "chrome";

function findExecutable(dir) {
  const expected =
    process.platform === "win32"
      ? ["chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome.exe"]
      : ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome"];
  for (const rel of expected) {
    if (fs.existsSync(path.join(dir, rel))) return rel;
  }
  function scan(current, depth = 0) {
    if (depth > 3) return null;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === exeName.toLowerCase()) {
        return path.relative(dir, full).replace(/\\/g, "/");
      }
      if (entry.isDirectory()) {
        const found = scan(full, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }
  return scan(dir);
}

const found = findExecutable(outputDir);
if (!found) {
  console.error("Isi vendor/chromium:", fs.readdirSync(outputDir));
  throw new Error("Executable Chromium (" + exeName + ") tidak ditemukan di vendor/chromium");
}
if (process.platform !== "win32") {
  fs.chmodSync(path.join(outputDir, found), 0o755);
}

try {
  fs.rmSync(downloadDir, { recursive: true, force: true });
} catch (e) {
  console.warn("Catatan: Gagal menghapus folder sementara (tidak menghentikan build):", e.message);
}
console.log("Chromium siap dibundel:", found);
