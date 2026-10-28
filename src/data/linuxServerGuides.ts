export interface ServerGuideStep {
  id: string;
  title: string;
  subtitle: string;
  filename: string;
  language: string;
  code: string;
  notes: string[];
}

export const LINUX_SERVER_GUIDES: ServerGuideStep[] = [
  {
    id: 'one-click-script',
    title: 'Otomatik Kurulum Scripti (Native Binary + Systemd + BBR + .audit.log)',
    subtitle:
      'Ubuntu 22.04/24.04, Debian 12 ve RHEL/AlmaLinux 9 üzerinde tek komutla TUS 10MB parça, BBR TCP hızlandırma, /var/log/filebrowser.log ve React UI içinden okunabilen /srv/transfers/.audit.log kancalarını kurar.',
    filename: 'linux-server/setup-filebrowser-production.sh',
    language: 'bash',
    code: `#!/usr/bin/env bash
set -euo pipefail

FB_PORT="\${FB_PORT:-8080}"
FB_ROOT_DIR="\${FB_ROOT_DIR:-/srv/transfers}"
FB_DB_PATH="/etc/filebrowser/filebrowser.db"
FB_LOG_PATH="/var/log/filebrowser.log"
FB_AUDIT_LOG="\${FB_ROOT_DIR}/.audit.log"
FB_ADMIN_USER="\${FB_ADMIN_USER:-admin}"
FB_ADMIN_PASS="\${FB_ADMIN_PASS:-ChangeMe_StrongPass2026!}"
TUS_CHUNK_BYTES="10485760" # 10 MB

sudo mkdir -p /etc/filebrowser "\$FB_ROOT_DIR"
sudo touch "\$FB_AUDIT_LOG" "\$FB_LOG_PATH"

# 1. Linux Kernel TCP BBR ve 10Gbps+ Soket Tampon Optimizasyonu
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

# 2. FileBrowser Kurulumu ve TUS 10MB Chunk Yapılandırması
curl -fsSL https://raw.githubusercontent.com/filebrowser/get/master/get.sh | sudo bash

sudo filebrowser config init \\
  --address 0.0.0.0 \\
  --port "\$FB_PORT" \\
  --root "\$FB_ROOT_DIR" \\
  --log "\$FB_LOG_PATH" \\
  --database "\$FB_DB_PATH"

sudo filebrowser config set \\
  --tus-chunk-size "\$TUS_CHUNK_BYTES" \\
  --tus-retry-count 10 \\
  --database "\$FB_DB_PATH"

sudo filebrowser users add "\$FB_ADMIN_USER" "\$FB_ADMIN_PASS" \\
  --perm.admin \\
  --commands "sh,echo,date,sha512sum" \\
  --database "\$FB_DB_PATH"

# 3. React Web Uygulamasından Okunabilen Otomatik Audit Log (.audit.log) Kancaları
sudo filebrowser cmds add after_upload "sh -c 'echo \\"\\\$(date -Iseconds) | UPLOAD | User: \\\$USERNAME | File: \\\$FILE\\" >> \${FB_AUDIT_LOG}'" --database "\$FB_DB_PATH"
sudo filebrowser cmds add after_delete "sh -c 'echo \\"\\\$(date -Iseconds) | DELETE | User: \\\$USERNAME | File: \\\$FILE\\" >> \${FB_AUDIT_LOG}'" --database "\$FB_DB_PATH"
sudo filebrowser cmds add after_rename "sh -c 'echo \\"\\\$(date -Iseconds) | RENAME | User: \\\$USERNAME | File: \\\$FILE\\" >> \${FB_AUDIT_LOG}'" --database "\$FB_DB_PATH"

# 4. Systemd Servisi
sudo tee /etc/systemd/system/filebrowser.service > /dev/null <<EOF
[Unit]
Description=FileBrowser High-Speed TUS & SHA-512 Server
After=network-online.target

[Service]
Type=simple
User=root
ExecStart=/usr/local/bin/filebrowser --database \${FB_DB_PATH}
Restart=always
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now filebrowser`,
    notes: [
      'after_upload, after_delete ve after_rename kancaları her işlemi otomatik olarak /srv/transfers/.audit.log dosyasına yazar.',
      'React Web Uygulamanız GET /api/raw/.audit.log (veya GET /api/resources/.audit.log?alt=media) isteğiyle tüm sunucu denetim geçmişini doğrudan ekranda gösterir.',
      'TCP BBR algoritması yüksek gecikmeli (WAN) bağlantılarda aktarım hızını 2x-5x artırır.',
    ],
  },
  {
    id: 'caddy-quic',
    title: 'Caddy Reverse Proxy (Otomatik TLS 1.3 + HTTP/3 QUIC + CORS)',
    subtitle:
      'Sınırsız dosya boyutu (max_size 0), sıfır tamponlama (flush_interval -1) ve TUS CORS başlıkları ile en hızlı HTTPS/QUIC katmanı.',
    filename: 'linux-server/Caddyfile',
    language: 'caddyfile',
    code: `files.alanadiniz.com {
    request_body {
        max_size 0
    }

    @cors_preflight method OPTIONS
    handle @cors_preflight {
        header Access-Control-Allow-Origin "*"
        header Access-Control-Allow-Methods "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS"
        header Access-Control-Allow-Headers "Authorization, X-Auth, Content-Type, Range, Tus-Resumable, Upload-Length, Upload-Offset, Upload-Metadata, Upload-Checksum"
        header Access-Control-Expose-Headers "Upload-Offset, Upload-Length, Location, Tus-Resumable, Content-Range, Accept-Ranges"
        header Access-Control-Max-Age "86400"
        respond "" 204
    }

    header {
        Access-Control-Allow-Origin "*"
        Access-Control-Expose-Headers "Upload-Offset, Upload-Length, Location, Tus-Resumable"
    }

    reverse_proxy 127.0.0.1:8080 {
        flush_interval -1
    }
}`,
    notes: [
      'Upload-Offset ve Tus-Resumable başlıklarının tarayıcıdan okunabilmesi için Access-Control-Expose-Headers zorunludur.',
      'Caddy varsayılan olarak UDP 443 üzerinden HTTP/3 (QUIC) protokolünü aktif eder.',
    ],
  },
  {
    id: 'nginx-conf',
    title: 'Nginx Reverse Proxy (Sınırsız Boyut + Zero Buffering)',
    subtitle:
      'Mevcut altyapınızda Nginx kullanıyorsanız 413 Request Entity Too Large hatasını önleyen ve doğrudan diske akış sağlayan ayar.',
    filename: 'linux-server/nginx-filebrowser.conf',
    language: 'nginx',
    code: `server {
    listen 443 ssl http2;
    server_name files.alanadiniz.com;

    client_max_body_size 0;            # Sınırsız dosya boyutu
    proxy_request_buffering off;       # Nginx diskine yazmadan doğrudan FileBrowser'a akıt
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    location / {
        if ($request_method = 'OPTIONS') {
            add_header 'Access-Control-Allow-Origin' '*' always;
            add_header 'Access-Control-Allow-Methods' 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS' always;
            add_header 'Access-Control-Allow-Headers' 'Authorization, X-Auth, Content-Type, Range, Tus-Resumable, Upload-Length, Upload-Offset, Upload-Metadata, Upload-Checksum' always;
            add_header 'Access-Control-Expose-Headers' 'Upload-Offset, Upload-Length, Location, Tus-Resumable, Content-Range, Accept-Ranges' always;
            return 204;
        }

        add_header 'Access-Control-Allow-Origin' '*' always;
        add_header 'Access-Control-Expose-Headers' 'Upload-Offset, Upload-Length, Location, Tus-Resumable' always;

        proxy_pass http://127.0.0.1:8080;
    }
}`,
    notes: [
      'proxy_request_buffering off ayarı olmazsa Nginx her 10 MB parçayı önce kendi /var/lib/nginx/body klasörüne yazar ve hızı yarıya düşürür.',
      'client_max_body_size 0 ile boyut sınırı tamamen kaldırılır.',
    ],
  },
];
