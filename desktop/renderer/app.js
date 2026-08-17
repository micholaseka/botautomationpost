const state = {
  photos: [],
  isLoggedIn: false,
  isPosting: false,
  awaitingManualAction: false,
  requiresManualConfirmation: false,
  detectedLocation: "",
  totalPosts: 0,
};

const els = {
  btnOpenBrowser: document.getElementById("btnOpenBrowser"),
  btnCloseBrowser: document.getElementById("btnCloseBrowser"),
  btnPost: document.getElementById("btnPost"),
  btnCancelPost: document.getElementById("btnCancelPost"),
  btnClearLog: document.getElementById("btnClearLog"),
  uploadArea: document.getElementById("uploadArea"),
  photosInput: document.getElementById("photos"),
  previewGrid: document.getElementById("previewGrid"),
  formBody: document.getElementById("formBody"),
  formLockBadge: document.getElementById("formLockBadge"),
  title: document.getElementById("title"),
  price: document.getElementById("price"),
  sku: document.getElementById("sku"),
  label: document.getElementById("label"),
  brand: document.getElementById("brand"),
  category: document.getElementById("category"),
  subcategory: document.getElementById("subcategory"),
  condition: document.getElementById("condition"),
  location: document.getElementById("location"),
  manualLocationStatus: document.getElementById("manualLocationStatus"),
  description: document.getElementById("description"),
  loops: document.getElementById("loops"),
  logContainer: document.getElementById("logContainer"),
  statusBadge: document.getElementById("statusBadge"),
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  loginStatusBox: document.getElementById("loginStatusBox"),
  loginStatusLabel: document.getElementById("loginStatusLabel"),
  loginIcon: document.getElementById("loginIcon"),
  pairingDetail: document.getElementById("pairingDetail"),
  metricPhotos: document.getElementById("metricPhotos"),
  metricPosts: document.getElementById("metricPosts"),
  progressBar: document.getElementById("progressBar"),
  progressFill: document.getElementById("progressFill"),
  progressLabel: document.getElementById("progressLabel"),
  btnContinuePost: document.getElementById("btnContinuePost"),
};

const api = window.electronAPI;

const MARKETPLACE_CATEGORY_TREE = {
  home_garden: {
    label: "Rumah & Taman",
    subcategories: {
      equipment: "Peralatan",
      furniture: "Mebel",
      home_appliances: "Peralatan Rumah Tangga",
      garden: "Kebun",
      tools: "Perkakas",
    },
  },

  entertainment: {
    label: "Hiburan",
    subcategories: {
      video_games: "Video Game",
      books: "Buku",
      films: "Film",
      music: "Musik",
    },
  },

  clothing_accessories: {
    label: "Pakaian & Aksesori",
    subcategories: {
      bags_luggage: "Tas & Koper",
      women_clothing_shoes: "Pakaian & Sepatu Wanita",
      men_clothing_shoes: "Pakaian & Sepatu Pria",
      jewelry_accessories: "Perhiasan & Aksesori",
    },
  },

  family: {
    label: "Keluarga",
    subcategories: {
      health_beauty: "Kesehatan & Kecantikan",
      pet_supplies: "Kebutuhan Hewan Peliharaan",
      baby_children: "Bayi & Anak-anak",
      toys_games: "Mainan & Game",
    },
  },

  electronics: {
    label: "Elektronik",
    subcategories: {
      electronics_computers: "Elektronik & Komputer",
      mobile_phones: "Telepon Seluler",
    },
  },

  hobbies: {
    label: "Hobi",
    subcategories: {
      bicycles: "Sepeda",
      arts_crafts: "Seni & Kerajinan",
      sports_outdoors: "Olahraga & Outdoor",
      auto_parts: "Komponen Otomotif",
      musical_instruments: "Alat Musik",
      antiques_collectibles: "Barang Antik & Koleksi",
    },
  },

  classifieds: {
    label: "Iklan Baris",
    subcategories: {
      clearance: "Cuci Gudang",
      other: "Lain-lain",
    },
  },

  vehicles: {
    label: "Kendaraan",
    subcategories: {},
  },
};

function updateSubcategoryOptions() {
  const categoryCode = els.category.value;
  const category = MARKETPLACE_CATEGORY_TREE[categoryCode];

  els.subcategory.replaceChildren();

  if (!category) {
    els.subcategory.disabled = true;

    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Pilih kategori utama terlebih dahulu";

    els.subcategory.appendChild(option);
    return;
  }

  const entries = Object.entries(category.subcategories);

  if (!entries.length) {
    els.subcategory.disabled = true;

    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Tidak ada subkategori";

    els.subcategory.appendChild(option);
    return;
  }

  els.subcategory.disabled = false;

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Pilih subkategori";

  els.subcategory.appendChild(placeholder);

  for (const [value, label] of entries) {
    const option = document.createElement("option");

    option.value = value;
    option.textContent = label;

    els.subcategory.appendChild(option);
  }
}
els.category.addEventListener("change", () => {
  updateSubcategoryOptions();
});

function getLocations() {
  return els.location.value
    .split("/")
    .map((value) => value.trim())
    .filter(Boolean);
}

function getTotalPosts() {
  return (
    getLocations().length *
    Math.max(1, Number.parseInt(els.loops.value, 10) || 1)
  );
}

function updateMetrics() {
  const total = getTotalPosts();
  state.totalPosts = total;
  els.metricPhotos.textContent = state.photos.length;
  els.metricPosts.textContent = total;
  if (!state.isPosting) {
    setProgress(0, total, total ? "Siap diproses" : "Menunggu data");
  }
}

function addPhotos(files) {
  const imageFiles = files.filter((file) => file.type.startsWith("image/"));
  if (!imageFiles.length) {
    appendLog("Hanya file gambar yang dapat ditambahkan.", "warn");
    return;
  }
  state.photos.push(
    ...imageFiles.map((file) => ({ file, url: URL.createObjectURL(file) })),
  );
  renderPreviews();
  updatePairingInfo();
}

function renderPreviews() {
  els.previewGrid.replaceChildren();
  els.uploadArea.classList.toggle("has-files", state.photos.length > 0);

  state.photos.forEach((photo, index) => {
    const item = document.createElement("div");
    item.className = "preview-item";
    const image = document.createElement("img");
    image.src = photo.url;
    image.alt = `Foto produk ${index + 1}`;
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "remove-btn";
    removeButton.title = "Hapus foto";
    removeButton.textContent = "×";
    removeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      URL.revokeObjectURL(photo.url);
      state.photos.splice(index, 1);
      renderPreviews();
      updatePairingInfo();
    });
    item.append(image, removeButton);
    els.previewGrid.appendChild(item);
  });
}

function updatePairingInfo() {
  const locations = getLocations();
  const loops = Math.max(1, Number.parseInt(els.loops.value, 10) || 1);
  updateMetrics();

  if (!state.photos.length) {
    els.pairingDetail.textContent =
      "Belum ada foto. Upload foto untuk melihat skema pasangan.";
    return;
  }
  if (!locations.length) {
    els.pairingDetail.textContent = `${state.photos.length} foto siap. Tambahkan minimal satu lokasi target dengan pemisah /.`;
    return;
  }

  const total = loops * locations.length;
  const samples = Array.from({ length: Math.min(4, total) }, (_, index) => {
    const photoNumber = (index % state.photos.length) + 1;
    return `#${index + 1}: Foto ${photoNumber} → ${locations[index % locations.length]}`;
  });
  els.pairingDetail.textContent = `${state.photos.length} foto × ${locations.length} lokasi × ${loops} putaran = ${total} formulir. Lokasi dan Terbitkan dipilih manual pada setiap formulir. ${samples.join(" · ")}${total > 4 ? ` · +${total - 4} lainnya` : ""}`;
}

els.uploadArea.addEventListener("click", () => els.photosInput.click());
els.uploadArea.addEventListener("dragover", (event) => {
  event.preventDefault();
  els.uploadArea.classList.add("dragover");
});
els.uploadArea.addEventListener("dragleave", () =>
  els.uploadArea.classList.remove("dragover"),
);
els.uploadArea.addEventListener("drop", (event) => {
  event.preventDefault();
  els.uploadArea.classList.remove("dragover");
  addPhotos(Array.from(event.dataTransfer.files));
});
els.photosInput.addEventListener("change", () => {
  addPhotos(Array.from(els.photosInput.files));
  els.photosInput.value = "";
});
els.location.addEventListener("input", updatePairingInfo);
els.loops.addEventListener("input", updatePairingInfo);

function appendLog(message, type = "") {
  els.logContainer.querySelector(".log-placeholder")?.remove();
  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`.trim();
  const time = new Date().toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  entry.textContent = `[${time}] ${message}`;
  els.logContainer.appendChild(entry);
  els.logContainer.scrollTop = els.logContainer.scrollHeight;
}

els.btnClearLog.addEventListener("click", () => {
  els.logContainer.innerHTML =
    '<div class="log-placeholder">Log dibersihkan.</div>';
});

function setStatus(stateValue, text) {
  els.statusBadge.className = "status-badge";
  els.statusDot.className = `status-dot${stateValue ? ` ${stateValue}` : ""}`;
  els.statusText.textContent = text;
}

function setProgress(current, total, label) {
  const percentage = total
    ? Math.min(100, Math.round((current / total) * 100))
    : 0;
  els.progressFill.style.width = `${percentage}%`;
  els.progressBar.classList.toggle("active", state.isPosting);
  els.progressLabel.textContent = label;
}

function setPostingState(isPosting) {
  state.isPosting = isPosting;
  if (!isPosting) {
    state.awaitingManualAction = false;
    state.requiresManualConfirmation = false;
    state.detectedLocation = "";
    els.manualLocationStatus.textContent =
      "Status lokasi: menunggu formulir dibuka.";
    els.manualLocationStatus.className = "manual-location-status";
  }
  els.btnCancelPost.classList.toggle("visible", isPosting);
  els.btnCancelPost.disabled = !isPosting;
  els.btnContinuePost.classList.toggle(
    "visible",
    isPosting && state.awaitingManualAction && state.requiresManualConfirmation,
  );
  els.btnContinuePost.disabled =
    !state.awaitingManualAction || !state.requiresManualConfirmation;
  els.btnPost.disabled = isPosting || !state.isLoggedIn;
  els.btnOpenBrowser.disabled = isPosting || state.isLoggedIn;
  els.btnCloseBrowser.disabled = !state.isLoggedIn;
  if (!isPosting) updateMetrics();
}

function setLoginState(isLoggedIn) {
  state.isLoggedIn = isLoggedIn;
  els.loginStatusBox.classList.toggle("logged-in", isLoggedIn);
  els.formBody.classList.toggle("form-disabled", !isLoggedIn);
  els.loginIcon.innerHTML = isLoggedIn ? "&#x2705;" : "&#x1F512;";
  els.loginStatusLabel.textContent = isLoggedIn
    ? "Status Login: Terdeteksi Login (Sesi Aktif)"
    : "Status Login: Belum Login";
  els.formLockBadge.innerHTML = isLoggedIn
    ? "&#x2705; Login Terdeteksi"
    : "&#x1F512; Login Diperlukan";
  els.formLockBadge.classList.toggle("unlocked", isLoggedIn);
  setPostingState(state.isPosting);
  els.btnPost.disabled = !isLoggedIn || state.isPosting;
  els.btnOpenBrowser.disabled = isLoggedIn || state.isPosting;
  els.btnCloseBrowser.disabled = !isLoggedIn;
  if (isLoggedIn && !state.isPosting)
    setStatus("active", "Sudah Login · Siap Posting");
}

function validateListing() {
  if (!state.photos.length) return "Pilih minimal satu foto produk.";
  if (!els.title.value.trim()) return "Judul produk wajib diisi.";
  if (!els.price.value.trim()) return "Harga wajib diisi.";
  if (!els.category.value) return "Pilih kategori utama Marketplace.";

  if (els.category.value !== "vehicles" && !els.subcategory.value) {
    return "Pilih subkategori Marketplace.";
  }

  if (!getLocations().length) {
    return "Isi minimal satu lokasi target. Pisahkan dengan tanda /.";
  }

  return "";
}

function buildListing() {
  return {
    photos: state.photos.map(
      ({ file }) => api.getFilePath?.(file) || file.path,
    ),
    title: els.title.value.trim(),
    price: els.price.value.trim(),
    sku: els.sku.value.trim(),
    label: els.label.value.trim(),
    brand: els.brand.value.trim(),
    category: els.category.value.trim(),
    subcategory: els.subcategory.value.trim(),
    condition: els.condition.value,
    description: els.description.value.trim(),
    locations: getLocations(),
    loops: Number.parseInt(els.loops.value, 10) || 1,
  };
}

function bridgeIpc() {
  if (!api) {
    appendLog(
      "electronAPI tidak tersedia. Jalankan aplikasi melalui Electron.",
      "error",
    );
    return;
  }
  api.onLog((message, level) => appendLog(message, level));
  api.onStatus((status) => {
    setStatus(status.state, status.text);
    const match = /(?:Posting|Formulir) (\d+)\/(\d+)/.exec(status.text);
    if (match) setProgress(Number(match[1]) - 1, Number(match[2]), status.text);
  });
  api.onLoginStatus((data) => setLoginState(data.isLoggedIn));
  api.onComplete(() => {
    setPostingState(false);
    setProgress(state.totalPosts, state.totalPosts, "Batch selesai");
    appendLog("Batch selesai diproses.", "success");
  });
  api.onCancelled(() => {
    setPostingState(false);
    setProgress(0, state.totalPosts, "Batch dibatalkan");
    appendLog("Batch dihentikan oleh pengguna.", "warn");
  });
  api.onError((error) => {
    setPostingState(false);
    appendLog(`Error: ${error}`, "error");
    setStatus("error", "Proses perlu diperiksa");
  });
  api.onManualActionRequired((data) => {
    state.awaitingManualAction = data.waiting;
    state.requiresManualConfirmation = Boolean(data.requiresConfirmation);
    if (data.waiting) {
      state.detectedLocation = "";
      els.manualLocationStatus.textContent =
        "Status lokasi: bot sudah mengetik lokasi; pilih saran lokasi dan Terbitkan di Marketplace.";
      els.manualLocationStatus.className = "manual-location-status";
    }
    setPostingState(state.isPosting);
    if (data.waiting) {
      appendLog(
        `${data.tag} menunggu Anda memilih lokasi dan menerbitkan listing di tab Marketplace. Tab berikutnya akan terbuka otomatis setelah terdeteksi.`,
        "warn",
      );
    }
  });
  api.onManualLocationSelected((data) => {
    state.detectedLocation = data.selectedLocation;
    els.manualLocationStatus.textContent = data.matchesExpected
      ? `Status lokasi: terdeteksi “${data.selectedLocation}”.`
      : `Status lokasi: terdeteksi “${data.selectedLocation}” (berbeda dari target “${data.expectedLocation}”).`;
    els.manualLocationStatus.className = `manual-location-status ${data.matchesExpected ? "detected" : "mismatch"}`;
    appendLog(
      `${data.tag} lokasi manual terdeteksi: ${data.selectedLocation}.`,
      data.matchesExpected ? "success" : "warn",
    );
  });
}

bridgeIpc();

els.btnOpenBrowser.addEventListener("click", async () => {
  if (!api) return;
  els.btnOpenBrowser.disabled = true;
  setStatus("busy", "Membuka browser…");
  try {
    const result = await api.openBrowser();
    if (!result.success)
      throw new Error(result.error || "Browser tidak dapat dibuka.");
    els.btnCloseBrowser.disabled = false;
    appendLog(
      "Browser terbuka. Selesaikan login Facebook secara manual.",
      "warn",
    );
    if (result.isLoggedIn) setLoginState(true);
  } catch (error) {
    appendLog(`Gagal membuka browser: ${error.message}`, "error");
    setStatus("error", "Browser gagal dibuka");
    els.btnOpenBrowser.disabled = false;
  }
});

els.btnCloseBrowser.addEventListener("click", async () => {
  if (!api) return;
  try {
    if (state.isPosting) await api.cancelPost();
    const result = await api.closeBrowser();
    if (!result.success)
      throw new Error(result.error || "Browser tidak dapat ditutup.");
  } catch (error) {
    appendLog(`Gagal menutup browser: ${error.message}`, "error");
  }
});

els.btnPost.addEventListener("click", async () => {
  if (!state.isLoggedIn || state.isPosting) return;
  const validationMessage = validateListing();
  if (validationMessage) {
    appendLog(validationMessage, "error");
    return;
  }
  if (!api) {
    appendLog("electronAPI tidak tersedia.", "error");
    return;
  }

  const listing = buildListing();
  state.totalPosts = listing.locations.length * listing.loops;
  setPostingState(true);
  setProgress(0, state.totalPosts, `Menyiapkan ${state.totalPosts} formulir`);
  setStatus("busy", "Memulai batch…");
  appendLog(
    `Memulai batch: ${state.totalPosts} formulir, ${listing.photos.length} foto.`,
    "info",
  );
  try {
    const result = await api.startPost(listing);
    if (!result.success && !result.cancelled)
      throw new Error(result.error || "Batch gagal dimulai.");
  } catch (error) {
    setPostingState(false);
    appendLog(`Gagal menjalankan batch: ${error.message}`, "error");
  }
});

els.btnCancelPost.addEventListener("click", async () => {
  if (!api || !state.isPosting) return;
  els.btnCancelPost.disabled = true;
  els.btnCancelPost.textContent = "Membatalkan…";
  try {
    const result = await api.cancelPost();
    if (!result.success)
      throw new Error(result.error || "Batch tidak dapat dibatalkan.");
    appendLog(
      "Permintaan pembatalan dikirim. Menyelesaikan tahap aktif…",
      "warn",
    );
  } catch (error) {
    appendLog(`Gagal membatalkan batch: ${error.message}`, "error");
    els.btnCancelPost.disabled = false;
  } finally {
    els.btnCancelPost.textContent = "Batalkan batch";
  }
});

els.btnContinuePost.addEventListener("click", async () => {
  if (!api || !state.awaitingManualAction) return;
  els.btnContinuePost.disabled = true;
  try {
    const result = await api.continueAfterManualPublish();
    if (!result.success || !result.continued) {
      throw new Error(
        result.error || "Tidak ada formulir yang menunggu konfirmasi.",
      );
    }
    state.awaitingManualAction = false;
    setPostingState(true);
    appendLog(
      "Penerbitan dikonfirmasi. Bot akan membuka formulir baru bila masih ada sisa batch.",
      "success",
    );
  } catch (error) {
    appendLog(`Gagal melanjutkan formulir: ${error.message}`, "error");
    els.btnContinuePost.disabled = false;
  }
});

(async () => {
  if (!api) return;
  try {
    const result = await api.checkSession();
    if (result.success && result.isLoggedIn) {
      setLoginState(true);
      appendLog("Sesi login aktif ditemukan.", "success");
    }
  } catch {
    /* Initial status is already rendered. */
  }
})();

window.addEventListener("beforeunload", () =>
  state.photos.forEach((photo) => URL.revokeObjectURL(photo.url)),
);
updatePairingInfo();
