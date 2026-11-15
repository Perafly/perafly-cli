# Perafly CLI — ajan yönergesi

Bu repo `perafly` komutudur (kısa adı `pf`): klasörü canlı adrese yayınlar, ajanları Perafly'a bağlar, yerel MCP
sunucusunu taşır. Repo yenidir; kod Faz 3'te başlar.

## Önce oku

1. `README.md`: komutlar, bayraklar, `--json` ve çıkış kodu sözleşmesi, `perafly.jsonc`, MCP.
2. `../perafly-backend/README.md`: ürün, kavramlar, açık API, izinler. Dört reponun ortak kaynağıdır.
3. `../perafly-backend/docs/DEVELOPMENT_STEPS.md`: fazlar, adımlar, durum.

## Kurallar

- CLI ince bir istemcidir. Sözleşme açık API'nin OpenAPI belgesidir; uzak işlem yapan her komut bir işlem adına
  (`operationId`) karşılık gelir. Uç OpenAPI'ye girmeden komutu yazılmaz.
- `--json` biçimi, hata `code`'ları, çıkış kodları, ortam değişkenleri ve `perafly.jsonc` şeması sözleşmedir; bunları
  bozan değişiklik ana sürüm ister ve `CHANGELOG.md`'ye yazılır.
- CLI derleme çalıştırmaz; derlemeyi Vercel yapar.
- Ajan kipi (`PERAFLY_AGENT=1`, `CI`) asla `--yes` anlamına gelmez. Yıkıcı uzak işlem her çağrıda açık `--yes` ister.
- Belirteç komut argümanı olarak alınmaz: ortam değişkeni ya da stdin. Anahtarlar ekrana, `--json` çıktısına ve
  tanılama loglarına yazılmaz.
- `.env*`, `.git`, `node_modules`, anahtar dosyaları ve `.perafly/state.json` hiçbir yoldan yüklenmez; sembolik bağ
  atlanır.
- CLI çıktısı İngilizcedir. Komut, bayrak ve hata kodu adları İngilizcedir.

## Çalışma düzeni

Lider Claude Fable 5.2'dir; diğer işler Claude Opus 5.5 alt ajanlarına yazılı görevle verilir. Güvenlik sınırı olan
kod (`src/auth/`, `src/publish/` dışlama kuralları, `src/mcp/` dosya erişimi) alt ajana verilmez.

Kullanıcı istemeden işleme (commit), itme (push) ya da npm yayını yapma.
