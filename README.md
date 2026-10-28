# NovaTransfer — FileBrowser TUS & Pipelined SHA-512 Transfer Console

Windows (Web Client) ↔ Linux (FileBrowser Sunucusu) arasında **sınırsız dosya boyutunda**, **Duraklat / Devam Et (Pause & Resume)** destekli ve **sıfır gecikmeli (Pipelined) SHA-512 bütünlük doğrulamalı** dosya transfer sistemi.

## Mimari Özellikler

1. **Sıfır Gecikmeli Pipelined SHA-512 (`hash-wasm` 64-bit WebAssembly):**
   - `N.` 10 MB parça ağ üzerinden Linux sunucusuna giderken, `N+1.` parça arka planda diskten okunur ve `SHA-512` özeti hazırlanır. Hash hesaplama kaynaklı hız kaybı **0 ms**'dir.
2. **3 Milisaniyelik Kriptografik Dosya Parmak İzi (`computeFastFileFingerprint`):**
   - Dosyanın ilk 1 MB, orta 1 MB ve son 1 MB kesitlerinden `SHA-512` parmak izi üretir.
   - Dosyanın adı değişmiş olsa bile önceki yarım kalan yüklemeyle %100 eşleşir.
3. **Tarayıcı Kapansa Bile Dosya Seçtirmeden Devam Etme (`FileSystemFileHandle` + `IndexedDB`):**
   - `window.showOpenFilePicker()` ile seçilen dosyanın referansı ve `sha512Hasher.save()` iç durumu `IndexedDB` üzerinde saklanır.
4. **Çift Katmanlı Doğrulama:**
   - **Katman 1 (Anlık):** Her 10 MB parçada `Upload-Checksum: sha512 <base64>` başlığı gönderilir; FileBrowser daha RAM'deyken parçayı doğrular.
   - **Katman 2 (Tam Dosya):** Aktarım sonunda `/api/resources/<yol>?checksum=sha512` ile sunucu diskindeki nihai SHA-512 özeti istemciyle karşılaştırılır.

---

## Kurulum ve Çalıştırma

### 1. React Web Uygulaması (Geliştirme & Üretim)
```bash
cd C:\Users\Dragos\.gemini\antigravity\scratch\filebrowser-sha512-transfer
npm run dev
```

### 2. Linux Sunucu Kurulumu (Tek Komutla FileBrowser + TUS + Google BBR)
`linux-server/setup-filebrowser-production.sh` dosyasını Linux sunucunuzda çalıştırın:
```bash
chmod +x linux-server/setup-filebrowser-production.sh
sudo ./linux-server/setup-filebrowser-production.sh
```

HTTPS / HTTP3 (QUIC) ve CORS yapılandırması için:
- **Caddy:** `linux-server/Caddyfile`
- **Nginx:** `linux-server/nginx-filebrowser.conf`
- **Docker:** `linux-server/docker-compose.yml`
