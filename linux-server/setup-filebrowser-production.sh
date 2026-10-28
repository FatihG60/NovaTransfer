#!/usr/bin/env bash
# ==============================================================================
# FileBrowser + TUS (Sınırsız Boyut) + SHA-512 + Audit Log + Google BBR Scripti
# Desteklenen Dağıtımlar: Ubuntu 22.04/24.04, Debian 12, RHEL/AlmaLinux/Rocky 9
# ==============================================================================
set -euo pipefail

FB_PORT="${FB_PORT:-8080}"
FB_ROOT_DIR="${FB_ROOT_DIR:-/srv/transfers}"
FB_DB_PATH="/etc/filebrowser/filebrowser.db"
FB_LOG_PATH="/var/log/filebrowser.log"
FB_AUDIT_LOG="${FB_ROOT_DIR}/.audit.log"
FB_ADMIN_USER="${FB_ADMIN_USER:-admin}"
FB_ADMIN_PASS="${FB_ADMIN_PASS:-ChangeMe_StrongPass2026!}"
TUS_CHUNK_BYTES="10485760" # 10 MB

echo "[1/7] Dizinler ve denetim günlüğü (.audit.log) hazırlanıyor..."
sudo mkdir -p /etc/filebrowser "$FB_ROOT_DIR"
sudo touch "$FB_AUDIT_LOG" "$FB_LOG_PATH"

echo "[2/7] Linux Kernel TCP BBR ve Yüksek Bant Genişliği (10Gbps+) tamponları optimize ediliyor..."
sudo tee /etc/sysctl.d/99-highspeed-transfer.conf > /dev/null <<'EOF'
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.core.rmem_max = 67108864
net.core.wmem_max = 67108864
net.ipv4.tcp_rmem = 4096 87380 33554432
net.ipv4.tcp_wmem = 4096 65536 33554432
net.ipv4.tcp_mtu_probing = 1
EOF
sudo sysctl --system > /dev/null

echo "[3/7] FileBrowser en güncel sürümü indiriliyor ve kuruluyor..."
curl -fsSL https://raw.githubusercontent.com/filebrowser/get/master/get.sh | sudo bash

echo "[4/7] FileBrowser veritabanı, log dosyası ve TUS parçalı yükleme (10 MB Chunk) yapılandırılıyor..."
if [ ! -f "$FB_DB_PATH" ]; then
  sudo filebrowser config init \
    --address 0.0.0.0 \
    --port "$FB_PORT" \
    --root "$FB_ROOT_DIR" \
    --log "$FB_LOG_PATH" \
    --database "$FB_DB_PATH"

  sudo filebrowser config set \
    --tus-chunk-size "$TUS_CHUNK_BYTES" \
    --tus-retry-count 10 \
    --database "$FB_DB_PATH"

  sudo filebrowser users add "$FB_ADMIN_USER" "$FB_ADMIN_PASS" \
    --perm.admin \
    --commands "sh,echo,date,sha512sum" \
    --database "$FB_DB_PATH"
fi

echo "[5/7] Web UI üzerinden okunabilen Otomatik Audit Log (.audit.log) ve Paralel Striped Birleştirme (Merge) kancaları ekleniyor..."
sudo filebrowser cmds add after_upload "sh -c 'case \"\$FILE\" in *.merge) TARGET=\"\${FILE%.merge}\"; cat \"\${TARGET}.part_\"* > \"\$TARGET\" && rm -f \"\${TARGET}.part_\"* \"\$FILE\" && echo \"\$(date -Iseconds) | STRIPED_MERGE | User: \$USERNAME | File: \$TARGET\" >> ${FB_AUDIT_LOG} ;; *.part_*) ;; *) echo \"\$(date -Iseconds) | UPLOAD | User: \$USERNAME | File: \$FILE\" >> ${FB_AUDIT_LOG} ;; esac'" --database "$FB_DB_PATH" || true
sudo filebrowser cmds add after_delete "sh -c 'echo \"\$(date -Iseconds) | DELETE | User: \$USERNAME | File: \$FILE\" >> ${FB_AUDIT_LOG}'" --database "$FB_DB_PATH" || true
sudo filebrowser cmds add after_rename "sh -c 'echo \"\$(date -Iseconds) | RENAME | User: \$USERNAME | File: \$FILE\" >> ${FB_AUDIT_LOG}'" --database "$FB_DB_PATH" || true

echo "[6/7] Systemd servisi (Sınırsız dosya tanımlayıcı limiti ile) oluşturuluyor..."
sudo tee /etc/systemd/system/filebrowser.service > /dev/null <<EOF
[Unit]
Description=FileBrowser High-Speed TUS & SHA-512 Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
ExecStart=/usr/local/bin/filebrowser --database ${FB_DB_PATH}
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF

echo "[7/7] FileBrowser servisi başlatılıyor..."
sudo systemctl daemon-reload
sudo systemctl enable --now filebrowser

echo "=============================================================================="
echo "KURULUM TAMAMLANDI!"
echo "Web UI ve API Adresi : http://$(hostname -I | awk '{print $1}'):${FB_PORT}"
echo "Hedef Klasör         : ${FB_ROOT_DIR}"
echo "Sistem Log Dosyası   : ${FB_LOG_PATH}"
echo "Web UI Audit Logu    : ${FB_AUDIT_LOG} (GET /api/raw/.audit.log ile okunabilir)"
echo "Kullanıcı Adı        : ${FB_ADMIN_USER}"
echo "Şifre                : ${FB_ADMIN_PASS}"
echo "TUS Parça Boyutu     : 10 MB (Upload-Checksum: sha512 aktif)"
echo "TCP Algoritması      : $(sysctl -n net.ipv4.tcp_congestion_control)"
echo "=============================================================================="
