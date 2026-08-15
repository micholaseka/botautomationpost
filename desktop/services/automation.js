import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";
import { EventEmitter } from "events";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const require = createRequire(import.meta.url);

const MARKETPLACE_CATEGORIES = {
    clothing: { label: "Pakaian & Aksesori", aliases: ["Pakaian & Aksesori", "Pakaian dan Aksesori", "Clothing"] },
    electronics: { label: "Elektronik", aliases: ["Elektronik", "Electronics"] },
    entertainment: { label: "Hiburan", aliases: ["Hiburan", "Entertainment"] },
    family: { label: "Keluarga", aliases: ["Keluarga", "Family"] },
    garden: { label: "Taman & Luar Ruangan", aliases: ["Taman dan luar ruangan", "Taman & Luar Ruangan", "Garden and outdoors"] },
    hobbies: { label: "Hobi", aliases: ["Hobi", "Hobbies"] },
    home_goods: { label: "Perlengkapan Rumah", aliases: ["Perlengkapan rumah", "Home goods"] },
    home_improvement: { label: "Perlengkapan Perbaikan Rumah", aliases: ["Perlengkapan perbaikan rumah", "Home improvement supplies"] },
    musical_instruments: { label: "Alat Musik", aliases: ["Alat musik", "Musical instruments"] },
    office_supplies: { label: "Perlengkapan Kantor", aliases: ["Perlengkapan kantor", "Office supplies"] },
    pet_supplies: { label: "Perlengkapan Hewan Peliharaan", aliases: ["Perlengkapan hewan peliharaan", "Pet supplies"] },
    sporting_goods: { label: "Barang Olahraga", aliases: ["Barang olahraga", "Sporting goods"] },
    toys_games: { label: "Mainan & Permainan", aliases: ["Mainan dan permainan", "Toys and games"] },
    other: { label: "Lainnya", aliases: ["Lainnya", "Other"] },
    vehicles: { label: "Kendaraan", aliases: ["Kendaraan", "Vehicles"] },
    property_rentals: { label: "Properti Disewakan", aliases: ["Properti disewakan", "Property for rent"] },
    property_sale: { label: "Properti Dijual", aliases: ["Properti dijual", "Property for sale"] },
    classifieds: { label: "Iklan Baris", aliases: ["Iklan baris", "Classifieds"] },
    free_stuff: { label: "Barang Gratis", aliases: ["Barang gratis", "Free stuff"] }
};

const MARKETPLACE_CONDITIONS = {
    new: { label: "Baru", aliases: ["Baru", "New"] },
    used_like_new: { label: "Bekas — Seperti Baru", aliases: ["Bekas - Seperti Baru", "Bekas — Seperti Baru", "Used - Like New"] },
    used_good: { label: "Bekas — Baik", aliases: ["Bekas - Baik", "Bekas — Baik", "Used - Good"] },
    used_fair: { label: "Bekas — Cukup Baik", aliases: ["Bekas - Cukup Baik", "Bekas — Cukup Baik", "Used - Fair"] },
    for_parts: { label: "Untuk Suku Cadang", aliases: ["Untuk Suku Cadang", "For parts or not working"] }
};

export class AutomationService extends EventEmitter {
    constructor({ sessionDirectory } = {}) {
        super();
        this.browser = null;
        this.context = null;
        this.page = null;
        // Login cookies are personal data.  Keep them in Electron's per-user
        // data directory instead of the application bundle, which is read-only
        // after installation and may be copied to another computer.
        this.sessionFile = path.join(sessionDirectory || path.join(PROJECT_ROOT, "storage"), "sessions", "default.json");
        this.isLoggedIn = false;
        this.running = false;
        this.stopRequested = false;
        this.manualAction = null;
        this.detectionTimer = null;
        this.browserInstallPromise = null;
    }

    async openBrowser() {
        if (this.browser && this.browser.isConnected()) {
            this.emit("log", "Browser Chromium sudah terbuka.", "info");
            return;
        }

        this.emit("log", "Membuka browser Chromium...", "info");
        this.emit("status", { state: "busy", text: "Membuka browser..." });

        try {
            await fs.mkdir(path.dirname(this.sessionFile), { recursive: true });
            const executablePath = await this.ensureChromiumInstalled();

            this.browser = await chromium.launch({
                headless: false,
                ...(executablePath ? { executablePath } : {}),
                args: [
                    "--start-maximized",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--disable-notifications",
                    "--disable-blink-features=AutomationControlled"
                ]
            });

            let storageState;
            try {
                await fs.access(this.sessionFile);
                storageState = this.sessionFile;
                this.emit("log", "Menggunakan sesi login tersimpan.", "info");
            } catch {
                this.emit("log", "Tidak ada sesi tersimpan. Silakan login manual.", "info");
            }

            this.context = await this.browser.newContext({
                ...(storageState ? { storageState } : {}),
                viewport: null
            });

            this.page = await this.context.newPage();
            this.page.setDefaultTimeout(45000);
            this.page.setDefaultNavigationTimeout(45000);

            this.emit("log", "Mengarahkan ke halaman login Facebook...", "info");
            this.emit("status", { state: "busy", text: "Membuka Facebook..." });
            await this.page.goto("https://www.facebook.com/login", { waitUntil: "domcontentloaded" });

            this.emit("log", "Browser siap. Silakan login manual di jendela Facebook yang terbuka.", "warn");
            this.emit("status", { state: "busy", text: "Menunggu login manual..." });

            this.startLoginDetection();
        } catch (err) {
            this.emit("log", `Gagal membuka browser: ${err.message}`, "error");
            this.emit("status", { state: "error", text: "Gagal Buka Browser" });
            await this.close();
            throw err;
        }
    }

    async ensureChromiumInstalled() {
        const bundledExecutable = await this.findBundledChromium();
        if (bundledExecutable) {
            this.emit("log", "Menggunakan Chromium yang disertakan bersama aplikasi.", "info");
            return bundledExecutable;
        }

        const executablePath = chromium.executablePath();
        try {
            await fs.access(executablePath);
            return null;
        } catch {
            // The Playwright package is present, but its managed browser has not been downloaded yet.
        }

        const cachedExecutable = await this.findCachedChromium();
        if (cachedExecutable) {
            this.emit("log", "Menggunakan Chromium Playwright yang sudah tersedia di komputer.", "info");
            return cachedExecutable;
        }

        if (!this.browserInstallPromise) {
            this.browserInstallPromise = this.installChromium().finally(() => {
                this.browserInstallPromise = null;
            });
        }
        await this.browserInstallPromise;
        return null;
    }

    async findBundledChromium() {
        // electron-builder puts extraResources beside app.asar. Supplying the
        // browser here makes the installer work on a computer with no Node.js
        // or previously downloaded Playwright browser.
        if (!process.resourcesPath) return null;

        for (const relativePath of [
            "chromium/chrome-win64/chrome.exe",
            "chromium/chrome-win/chrome.exe"
        ]) {
            const executablePath = path.join(process.resourcesPath, relativePath);
            try {
                await fs.access(executablePath);
                return executablePath;
            } catch {
                // Try the other Chromium folder layout.
            }
        }
        return null;
    }

    async findCachedChromium() {
        const cacheRoot = path.join(process.env.LOCALAPPDATA || "", "ms-playwright");
        if (!process.env.LOCALAPPDATA) return null;

        try {
            const entries = await fs.readdir(cacheRoot, { withFileTypes: true });
            const candidates = entries
                .filter(entry => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
                .map(entry => entry.name)
                .sort((left, right) => Number(right.slice(9)) - Number(left.slice(9)));

            for (const candidate of candidates) {
                for (const relativePath of ["chrome-win64/chrome.exe", "chrome-win/chrome.exe"]) {
                    const executablePath = path.join(cacheRoot, candidate, relativePath);
                    try {
                        await fs.access(executablePath);
                        return executablePath;
                    } catch {
                        // Try the next executable layout or cached browser revision.
                    }
                }
            }
        } catch {
            // No local Playwright cache is available.
        }
        return null;
    }

    async installChromium() {
        this.emit("log", "Chromium Playwright belum tersedia. Mengunduh browser otomatis (hanya sekali)...", "warn");
        this.emit("status", { state: "busy", text: "Menyiapkan Chromium..." });

        const playwrightCli = require.resolve("playwright/cli");
        await new Promise((resolve, reject) => {
            let installOutput = "";
            const installer = spawn(process.execPath, [playwrightCli, "install", "chromium"], {
                cwd: PROJECT_ROOT,
                windowsHide: true,
                // When packaged, process.execPath is the application .exe rather
                // than node.exe. This makes Electron run Playwright's CLI as Node.
                env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
            });

            const collectOutput = chunk => {
                installOutput = `${installOutput}${chunk}`.slice(-1500);
            };
            installer.stdout.on("data", collectOutput);
            installer.stderr.on("data", collectOutput);
            installer.on("error", reject);
            installer.on("close", code => {
                if (code === 0) resolve();
                else reject(new Error(`Unduhan Chromium gagal (kode ${code}). ${installOutput.trim()}`));
            });
        });

        const executablePath = chromium.executablePath();
        try {
            await fs.access(executablePath);
        } catch {
            throw new Error("Unduhan Chromium selesai, tetapi executable browser tidak ditemukan.");
        }

        this.emit("log", "Chromium Playwright siap digunakan.", "success");
    }

    startLoginDetection() {
        if (this.detectionTimer) clearInterval(this.detectionTimer);

        this.detectionTimer = setInterval(async () => {
            try {
                if (!this.browser || !this.browser.isConnected() || !this.page || this.page.isClosed()) {
                    clearInterval(this.detectionTimer);
                    this.detectionTimer = null;
                    return;
                }

                const cookies = await this.context.cookies();
                const hasUser = cookies.some(c => c.name === "c_user");
                const hasXs = cookies.some(c => c.name === "xs");

                if (hasUser && hasXs) {
                    if (!this.isLoggedIn) {
                        this.isLoggedIn = true;
                        this.emit("log", "Login terdeteksi sukses! Pengguna sudah login ke Facebook.", "success");
                        this.emit("status", { state: "active", text: "Sudah Login (Siap Posting)" });
                        this.emit("login_status", { isLoggedIn: true });

                        try {
                            await this.context.storageState({ path: this.sessionFile });
                            this.emit("log", "Sesi login berhasil disimpan.", "info");
                        } catch (e) {
                            console.error("Gagal simpan sesi:", e.message);
                        }
                    }
                } else {
                    if (this.isLoggedIn) {
                        this.isLoggedIn = false;
                        this.emit("log", "Sesi terputus. Silakan login kembali.", "warn");
                        this.emit("status", { state: "busy", text: "Menunggu login..." });
                        this.emit("login_status", { isLoggedIn: false });
                    }
                }
            } catch {
                // Ignore transient evaluation errors when page navigates
            }
        }, 2500);
    }

    async checkLoginStatus() {
        if (!this.context || !this.page || this.page.isClosed()) {
            return false;
        }
        try {
            const cookies = await this.context.cookies();
            const hasUser = cookies.some(c => c.name === "c_user");
            const hasXs = cookies.some(c => c.name === "xs");
            this.isLoggedIn = hasUser && hasXs;
            return this.isLoggedIn;
        } catch {
            return false;
        }
    }

    async postBatch(payload) {
        if (this.running) {
            throw new Error("Proses posting sedang berjalan. Mohon tunggu hingga selesai.");
        }

        const isLoggedIn = await this.checkLoginStatus();
        if (!isLoggedIn) {
            throw new Error("Belum terdeteksi login. Silakan login manual ke Facebook terlebih dahulu.");
        }

        const listing = await this.validatePayload(payload);
        this.running = true;
        this.stopRequested = false;

        const { photoPaths, locations, title, price, sku, label, brand, category, condition, description, loops } = listing;

        const totalPostings = loops * locations.length;

        this.emit("log", "--- MEMULAI BATCH POSTING ---", "info");
        this.emit("log", `Foto: ${photoPaths.length} file, Lokasi: ${locations.length}, Total formulir: ${totalPostings}`, "info");
        this.emit("log", "Lokasi dan Terbitkan akan dilakukan manual pada setiap formulir.", "warn");

        try {
            let currentIndex = 0;

            for (let loop = 1; loop <= loops; loop++) {
                for (let locationIndex = 0; locationIndex < locations.length; locationIndex++) {
                    this.throwIfCancelled();
                    const expectedLocation = locations[locationIndex];
                    const postingNumber = currentIndex + 1;

                    const photoIndex = currentIndex % photoPaths.length;
                    const photoForThisPost = [photoPaths[photoIndex]];

                    const tag = `[Formulir ${postingNumber}/${totalPostings} | Lokasi: "${expectedLocation}"]`;
                    this.emit("log", `${tag} Menggunakan foto ke-${photoIndex + 1}`, "info");
                    this.emit("status", { state: "busy", text: `Posting ${postingNumber}/${totalPostings}...` });

                    await this.executeSinglePost({
                        photos: photoForThisPost,
                        title,
                        price,
                        sku, label, brand,
                        category,
                        condition,
                        description,
                        expectedLocation
                    }, tag);

                    this.throwIfCancelled();

                    this.emit("log", `${tag} Lokasi dan penerbitan telah dikonfirmasi manual.`, "success");

                    currentIndex++;

                }
            }

            this.emit("log", `=== SEMUA ${totalPostings} FORMULIR SELESAI DIKONFIRMASI ===`, "success");
            this.emit("status", { state: "active", text: "Sudah Login (Siap Posting)" });
            this.emit("complete");
            return { cancelled: false };
        } catch (err) {
            if (err.code === "BATCH_CANCELLED" || this.stopRequested) {
                this.emit("log", "Batch posting dibatalkan oleh pengguna.", "warn");
                const browserStillOpen = this.context && this.page && !this.page.isClosed() && this.isLoggedIn;
                this.emit("status", browserStillOpen
                    ? { state: "active", text: "Sudah Login (Siap Posting)" }
                    : { state: "", text: "Browser Ditutup" });
                this.emit("cancelled");
                return { cancelled: true };
            }
            this.emit("log", `Error saat posting: ${err.message}`, "error");
            this.emit("status", { state: "error", text: "Error Posting" });
            this.emit("error", err.message);
            throw err;
        } finally {
            this.running = false;
            this.stopRequested = false;
        }
    }

    async validatePayload(payload = {}) {
        const photoPaths = Array.isArray(payload.photos) ? payload.photos.filter(Boolean) : [];
        if (!photoPaths.length) throw new Error("Minimal sertakan 1 foto produk.");

        const missingPhoto = await Promise.all(photoPaths.map(async photoPath => {
            try {
                return !(await fs.stat(photoPath)).isFile();
            } catch {
                return true;
            }
        }));
        if (missingPhoto.some(Boolean)) throw new Error("Satu atau lebih foto tidak ditemukan. Pilih ulang foto produk.");

        const title = String(payload.title || "").trim();
        const price = String(payload.price || "").replace(/[^0-9]/g, "");
        const locations = (Array.isArray(payload.locations) ? payload.locations : String(payload.locations || "").split("/"))
            .map(location => String(location || "").trim())
            .filter(Boolean);
        const category = String(payload.category || "").trim();
        const condition = String(payload.condition || "").trim();
        const loops = Number.parseInt(payload.loops, 10);

        if (!title) throw new Error("Judul produk wajib diisi.");
        if (!price || Number(price) <= 0) throw new Error("Harga produk wajib berupa angka lebih dari 0.");
        if (!locations.length) throw new Error("Masukkan minimal satu lokasi target. Pisahkan lokasi dengan tanda /.");
        if (!MARKETPLACE_CATEGORIES[category]) throw new Error("Pilih kategori Marketplace dari daftar yang tersedia.");
        if (condition && !MARKETPLACE_CONDITIONS[condition]) throw new Error("Pilih kondisi barang dari daftar yang tersedia.");
        if (!Number.isInteger(loops) || loops < 1 || loops > 100) throw new Error("Jumlah perulangan harus antara 1 sampai 100.");

        return {
            photoPaths, locations, title, price,
            sku: String(payload.sku || "").trim(),
            label: String(payload.label || "").trim(),
            brand: String(payload.brand || "").trim(),
            category, condition,
            description: String(payload.description || "").trim(),
            loops
        };
    }

    cancelBatch() {
        if (!this.running) return false;
        this.stopRequested = true;
        this.manualAction?.resolve();
        this.emit("log", "Permintaan pembatalan diterima. Menyelesaikan tahap aktif...", "warn");
        return true;
    }

    continueAfterManualPublish() {
        if (!this.running || !this.manualAction) return false;
        this.manualAction.resolve();
        return true;
    }

    throwIfCancelled() {
        if (!this.stopRequested) return;
        const error = new Error("Batch dibatalkan.");
        error.code = "BATCH_CANCELLED";
        throw error;
    }

    async waitWithCancellation(milliseconds) {
        const deadline = Date.now() + milliseconds;
        while (Date.now() < deadline) {
            this.throwIfCancelled();
            await new Promise(resolve => setTimeout(resolve, Math.min(250, deadline - Date.now())));
        }
        this.throwIfCancelled();
    }

    async executeSinglePost(item, tag) {
        this.throwIfCancelled();
        this.emit("log", `${tag} Membuka tab formulir Marketplace baru...`, "info");
        this.page = await this.context.newPage();
        this.page.setDefaultTimeout(45000);
        this.page.setDefaultNavigationTimeout(45000);
        this.emit("log", `${tag} Membuka halaman Marketplace Create Item...`, "info");
        await this.page.goto("https://www.facebook.com/marketplace/create/item", {
            waitUntil: "domcontentloaded",
            timeout: 60000
        });

        await this.uploadPhotos(item.photos, tag);
        await this.fillTitle(item.title, tag);
        await this.fillPrice(item.price, tag);
        await this.selectCategory(item.category, tag);
        await this.selectCondition(item.condition, tag);
        await this.fillSku(item.sku, tag);
        await this.fillLabel(item.label, tag);
        await this.fillBrand(item.brand, tag);
        await this.fillDescription(item.description, tag);
        await this.typeLocation(item.expectedLocation, tag);
        await this.waitForManualLocationAndPublish(tag, item.expectedLocation);
    }

    async uploadPhotos(photos, tag) {
        this.throwIfCancelled();
        this.emit("log", `${tag} Mengunggah foto...`, "info");
        const fileInput = this.page.locator('input[type="file"]').first();
        await fileInput.waitFor({ state: "attached", timeout: 20000 });
        await fileInput.setInputFiles(photos);

        const spinner = this.page.locator('[role="progressbar"], [aria-busy="true"]').first();
        if (await spinner.count() > 0) {
            await spinner.waitFor({ state: "detached", timeout: 30000 }).catch(() => {});
        }
        this.emit("log", `${tag} Foto berhasil diupload.`, "success");
    }

    async fillTitle(title, tag) {
        if (!title) return;
        this.emit("log", `${tag} Mengisi judul: "${title}"`, "info");
        const loc = this.page.locator('input[aria-label="Title"], input[aria-label="Judul"], label:has-text("Title") input, label:has-text("Judul") input').first();
        if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
            await loc.scrollIntoViewIfNeeded();
            await loc.click();
            await loc.fill("");
            await loc.fill(title);
        } else {
            throw new Error("Kolom judul Marketplace tidak ditemukan.");
        }
    }

    async fillPrice(price, tag) {
        if (!price) return;
        this.emit("log", `${tag} Mengisi harga: Rp${price}`, "info");
        const loc = this.page.locator('input[aria-label="Price"], input[aria-label="Harga"], label:has-text("Price") input, label:has-text("Harga") input').first();
        if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
            await loc.scrollIntoViewIfNeeded();
            await loc.click();
            await loc.fill("");
            await loc.fill(String(price));
        } else {
            throw new Error("Kolom harga Marketplace tidak ditemukan.");
        }
    }

    async selectCategory(categoryCode, tag) {
        const category = MARKETPLACE_CATEGORIES[categoryCode];
        if (!category) throw new Error("Kategori Marketplace yang dipilih tidak valid.");
        this.emit("log", `${tag} Memilih kategori: "${category.label}"`, "info");
        await this.selectMarketplaceChoice({
            controlSelector: '[aria-label="Category"], [aria-label="Kategori"], [role="combobox"][aria-label="Category"], [role="combobox"][aria-label="Kategori"]',
            aliases: category.aliases,
            fieldName: "kategori",
            fieldLabels: ["Category", "Kategori", "Pilih category", "Pilih kategori"]
        });
    }

    async selectCondition(conditionCode, tag) {
        if (!conditionCode) return;
        const condition = MARKETPLACE_CONDITIONS[conditionCode];
        if (!condition) throw new Error("Kondisi barang yang dipilih tidak valid.");
        this.emit("log", `${tag} Memilih kondisi: "${condition.label}"`, "info");
        await this.selectMarketplaceChoice({
            controlSelector: '[aria-label="Condition"], [aria-label="Kondisi"], [role="combobox"][aria-label="Condition"], [role="combobox"][aria-label="Kondisi"], input[placeholder="Condition"], input[placeholder="Kondisi"]',
            aliases: condition.aliases,
            fieldName: "kondisi barang",
            fieldLabels: ["Condition", "Kondisi", "Pilih condition", "Pilih kondisi"]
        });
    }

    async selectMarketplaceChoice({ controlSelector, aliases, fieldName, fieldLabels }) {
        const control = await this.findMarketplaceFieldControl(controlSelector, fieldLabels);
        if (!control) throw new Error(`Kolom ${fieldName} Marketplace tidak ditemukan.`);

        await control.scrollIntoViewIfNeeded();
        await control.click();
        await this.waitWithCancellation(600);

        let option = await this.findOptionByAliases(aliases);
        if (!option) {
            const searchInput = await this.findFirstVisible(this.page.locator('[role="dialog"] input, [role="listbox"] input, input[aria-label="Search"], input[aria-label="Cari"]'));
            if (searchInput) {
                await searchInput.fill(aliases[0]);
            } else {
                await this.page.keyboard.type(aliases[0], { delay: 35 });
            }
            await this.waitWithCancellation(600);
            option = await this.findOptionByAliases(aliases);
        }

        if (!option) throw new Error(`Pilihan ${fieldName} tidak tersedia pada formulir Marketplace ini.`);
        await option.click();
        await this.waitWithCancellation(700);
        await this.verifyMarketplaceChoice(control, aliases, fieldName);
    }

    async findMarketplaceFieldControl(controlSelector, fieldLabels) {
        const timeoutAt = Date.now() + 15000;
        const labelButtonSelector = fieldLabels
            .map(label => `[role="button"]:has-text("${label}"), [role="combobox"]:has-text("${label}")`)
            .join(", ");

        while (Date.now() < timeoutAt) {
            const directControl = await this.findFirstVisible(this.page.locator(controlSelector));
            if (directControl) return directControl;

            const textControl = await this.findFirstVisible(this.page.locator(labelButtonSelector));
            if (textControl) return textControl;

            for (const label of fieldLabels) {
                const labelledControl = await this.findFirstVisible(this.page.getByLabel(label, { exact: false }));
                if (labelledControl) return labelledControl;

                const labelNode = await this.findFirstVisible(this.page.getByText(label, { exact: true }));
                if (!labelNode) continue;

                const fieldContainer = labelNode.locator("xpath=ancestor::*[.//*[@role='button' or @role='combobox' or self::input]][1]");
                const nestedControl = await this.findFirstVisible(fieldContainer.locator('[role="button"], [role="combobox"], input'));
                if (nestedControl) return nestedControl;

                const parentControl = await this.findFirstVisible(
                    labelNode.locator("xpath=ancestor-or-self::*[@role='button' or @role='combobox'][1]")
                );
                if (parentControl) return parentControl;

                const nearbyControl = await this.findFirstVisible(
                    labelNode.locator("xpath=following::*[@role='button' or @role='combobox'][1]")
                );
                if (nearbyControl) return nearbyControl;
            }

            await this.waitWithCancellation(300);
        }
        return null;
    }

    async verifyMarketplaceChoice(control, aliases, fieldName) {
        const displayedValue = (await control.innerText().catch(() => "")).trim().toLocaleLowerCase();
        if (!displayedValue) return;
        const wasSelected = aliases.some(alias => displayedValue.includes(alias.toLocaleLowerCase()));
        if (!wasSelected) {
            throw new Error(`Nilai ${fieldName} tidak berubah setelah dipilih. Coba buka ulang formulir Marketplace.`);
        }
    }

    async findOptionByAliases(aliases) {
        for (const alias of aliases) {
            const roleOption = await this.findFirstVisible(this.page.getByRole("option", { name: alias, exact: false }));
            if (roleOption) return roleOption;

            const menuChoice = await this.findFirstVisible(
                this.page.locator('[role="menuitem"], [role="button"]').filter({ hasText: alias })
            );
            if (menuChoice) return menuChoice;
        }
        return null;
    }

    async findFirstVisible(locator) {
        const count = await locator.count();
        for (let index = 0; index < count; index++) {
            const candidate = locator.nth(index);
            if (await candidate.isVisible().catch(() => false)) return candidate;
        }
        return null;
    }

    async fillSku(sku, tag) {
        if (!sku) return;
        this.emit("log", `${tag} Mengisi SKU: "${sku}"`, "info");
        const loc = this.page.locator('input[aria-label="SKU"], input[aria-label="Sku"], label:has-text("SKU") input, input[aria-label="Kode"]').first();
        if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
            await loc.scrollIntoViewIfNeeded();
            await loc.click();
            await loc.fill("");
            await loc.fill(sku);
        }
    }

    async fillLabel(label, tag) {
        await this.fillMarketplaceTextField(label, tag, {
            fieldName: "label",
            selectors: 'input[aria-label*="Label" i], input[aria-label*="Tag" i], input[placeholder*="Label" i], input[placeholder*="Tag" i], input[name*="label" i], input[name*="tag" i], [role="combobox"][aria-label*="Label" i], [role="combobox"][aria-label*="Tag" i], label:has-text("Label") input, label:has-text("Tag") input, [contenteditable="true"][aria-label*="Label" i]',
            fieldLabels: ["Label", "Label produk", "Tag", "Tag produk"]
        });
    }

    async fillBrand(brand, tag) {
        await this.fillMarketplaceTextField(brand, tag, {
            fieldName: "merek",
            selectors: 'input[aria-label*="Brand" i], input[aria-label*="Merek" i], input[placeholder*="Brand" i], input[placeholder*="Merek" i], input[name*="brand" i], input[name*="merek" i], [role="combobox"][aria-label*="Brand" i], [role="combobox"][aria-label*="Merek" i], label:has-text("Brand") input, label:has-text("Merek") input, [contenteditable="true"][aria-label*="Brand" i], [contenteditable="true"][aria-label*="Merek" i]',
            fieldLabels: ["Brand", "Merek", "Pilih Brand", "Pilih Merek"]
        });
    }

    async fillMarketplaceTextField(value, tag, { fieldName, selectors, fieldLabels }) {
        if (!value) return;
        this.emit("log", `${tag} Mengisi ${fieldName}: "${value}"`, "info");

        let input = await this.findFirstVisible(this.page.locator(selectors));
        let openedControl = null;
        if (!input) {
            const control = await this.findMarketplaceFieldControl(selectors, fieldLabels);
            if (!control) {
                this.emit("log", `${tag} Kolom ${fieldName} tidak tersedia pada kategori ini. Lewati isian dan lanjutkan ke formulir.`, "warn");
                return;
            }
            openedControl = control;
            await control.scrollIntoViewIfNeeded();
            await control.click();
            const controlTagName = await control.evaluate(element => element.tagName.toLowerCase()).catch(() => "");
            const controlIsEditable = await control.getAttribute("contenteditable").catch(() => null) === "true";
            input = ["input", "textarea"].includes(controlTagName) || controlIsEditable
                ? control
                : await this.findFirstVisible(control.locator('input, textarea, [contenteditable="true"]'));
            if (!input) {
                input = await this.findFirstVisible(this.page.locator('[role="dialog"] input, [role="listbox"] input, [role="dialog"] [contenteditable="true"]'));
            }
        }

        try {
            if (input) {
                await this.setMarketplaceText(input, value);
            } else if (openedControl) {
                // Beberapa versi Marketplace membuka daftar pilihan tanpa input pencarian.
                // Ketik langsung ke daftar tersebut agar penyaring bawaan Facebook tetap bekerja.
                await this.page.keyboard.type(value);
            } else {
                this.emit("log", `${tag} Kolom ${fieldName} tidak dapat dibuka pada formulir ini. Lewati isian dan lanjutkan ke formulir.`, "warn");
                return;
            }

            const option = await this.findOptionByAliases([value]);
            if (option) {
                await option.click();
            }
        } catch (error) {
            this.emit("log", `${tag} Gagal mengisi ${fieldName}: ${error.message}. Lewati isian dan lanjutkan ke formulir.`, "warn");
        }
    }

    async setMarketplaceText(field, value) {
        await field.scrollIntoViewIfNeeded();
        const isEditable = await field.getAttribute("contenteditable").catch(() => null) === "true";
        if (isEditable) {
            await field.click();
            await this.page.keyboard.press("Control+A");
            await this.page.keyboard.type(value);
            return;
        }
        await field.fill("");
        await field.fill(value);
    }

    async fillDescription(description, tag) {
        if (!description) return;
        this.emit("log", `${tag} Mengisi deskripsi...`, "info");
        const loc = this.page.locator('textarea[aria-label="Description"], textarea[aria-label="Deskripsi"], label:has-text("Description") textarea, label:has-text("Deskripsi") textarea').first();
        if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
            await loc.scrollIntoViewIfNeeded();
            await loc.click();
            await loc.fill("");
            await loc.fill(description);
            return;
        }
        const fallback = this.page.locator('textarea').first();
        if (await fallback.count() > 0 && await fallback.isVisible().catch(() => false)) {
            await fallback.scrollIntoViewIfNeeded();
            await fallback.click();
            await fallback.fill("");
            await fallback.fill(description);
        }
    }

    async typeLocation(location, tag) {
        if (!location) return;
        this.emit("log", `${tag} Mengetik lokasi: "${location}" (tanpa memilih saran)...`, "info");
        const selectors = [
            'input[aria-label="Location"]',
            'input[aria-label="Lokasi"]',
            'input[placeholder="Location"]',
            'input[placeholder="Lokasi"]',
            'input[name*="location" i]',
            'input[name*="lokasi" i]',
            'label:has-text("Location") input',
            'label:has-text("Lokasi") input'
        ].join(", ");
        let field = await this.findFirstVisible(this.page.locator(selectors));
        if (!field) {
            const control = await this.findMarketplaceFieldControl(selectors, ["Location", "Lokasi"]);
            if (control) {
                const tagName = await control.evaluate(element => element.tagName.toLowerCase()).catch(() => "");
                field = tagName === "input" ? control : await this.findFirstVisible(control.locator("input"));
            }
        }

        if (!field) throw new Error("Kolom lokasi Marketplace tidak ditemukan.");
        await this.setMarketplaceText(field, location);
    }

    async waitForManualLocationAndPublish(tag, expectedLocation) {
        this.throwIfCancelled();
        this.emit("log", `${tag} Formulir siap. Pilih saran lokasi yang sudah diketik, lalu tekan Terbitkan secara manual.`, "warn");
        this.emit("status", { state: "busy", text: `${tag} Menunggu lokasi & Terbitkan manual` });

        let lastDetectedLocation = "";
        const detectLocation = async () => {
            const selectedLocation = await this.detectSelectedMarketplaceLocation();
            if (!selectedLocation || selectedLocation === lastDetectedLocation) return;

            lastDetectedLocation = selectedLocation;
            const normalizedExpected = expectedLocation.toLocaleLowerCase();
            const normalizedSelected = selectedLocation.toLocaleLowerCase();
            const matchesExpected = normalizedSelected.includes(normalizedExpected) || normalizedExpected.includes(normalizedSelected);
            this.emit("log", `${tag} Lokasi manual terdeteksi: "${selectedLocation}"${matchesExpected ? "" : ` (target: "${expectedLocation}")`}.`, matchesExpected ? "success" : "warn");
            this.emit("manual_location_selected", { tag, selectedLocation, expectedLocation, matchesExpected });
        };

        let action;
        const isPublished = async () => {
            const currentUrl = this.page.url();
            if (!/\/marketplace\/create\/item/i.test(currentUrl)) return true;

            const bodyText = await this.page.locator("body").innerText().catch(() => "");
            return /(your listing (is|was) (now )?published|listing published|your item (is|was) (now )?published|iklan anda (sudah |telah )?diterbitkan|barang anda (sudah |telah )?diterbitkan|listing berhasil diterbitkan|berhasil menerbitkan)/i.test(bodyText);
        };

        const monitorManualActions = async () => {
            await detectLocation();
            if (await isPublished()) {
                this.emit("log", `${tag} Penerbitan manual terdeteksi. Membuka formulir berikutnya...`, "success");
                this.manualAction?.resolve();
            }
        };

        await monitorManualActions();
        const manualWatcher = setInterval(() => {
            monitorManualActions().catch(() => {});
        }, 300);

        try {
            await new Promise(resolve => {
                action = { resolve };
                this.manualAction = action;
                this.emit("manual_action_required", { waiting: true, tag, requiresConfirmation: false });
            });
        } finally {
            clearInterval(manualWatcher);
            if (this.manualAction === action) this.manualAction = null;
            this.emit("manual_action_required", { waiting: false });
        }

        this.throwIfCancelled();
    }

    async detectSelectedMarketplaceLocation() {
        const visibleSuggestion = await this.findFirstVisible(this.page.locator('[role="listbox"] [role="option"], [role="listbox"] li'));
        if (visibleSuggestion) return "";

        const locationControls = this.page.locator([
            'input[aria-label="Location"]',
            'input[aria-label="Lokasi"]',
            'input[placeholder="Location"]',
            'input[placeholder="Lokasi"]',
            '[role="combobox"][aria-label="Location"]',
            '[role="combobox"][aria-label="Lokasi"]'
        ].join(", "));

        const count = await locationControls.count();
        for (let index = 0; index < count; index++) {
            const control = locationControls.nth(index);
            if (!await control.isVisible().catch(() => false)) continue;
            if (await control.getAttribute("aria-expanded").catch(() => null) === "true") continue;

            const value = (await control.inputValue().catch(() => "") || await control.innerText().catch(() => "")).trim();
            if (value && !/^(location|lokasi)$/i.test(value)) return value;
        }
        return "";
    }

    async close() {
        if (this.detectionTimer) {
            clearInterval(this.detectionTimer);
            this.detectionTimer = null;
        }
        this.cancelBatch();
        this.isLoggedIn = false;

        try { if (this.page && !this.page.isClosed()) await this.page.close(); } catch {}
        try { if (this.context) await this.context.close(); } catch {}
        try { if (this.browser && this.browser.isConnected()) await this.browser.close(); } catch {}

        this.browser = null;
        this.context = null;
        this.page = null;

        this.emit("log", "Browser telah ditutup.", "info");
        this.emit("status", { state: "", text: "Browser Ditutup" });
        this.emit("login_status", { isLoggedIn: false });
    }
}
