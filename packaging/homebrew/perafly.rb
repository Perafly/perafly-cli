# Perafly CLI Homebrew formülü: ŞABLON (README §8). `npm run homebrew:formula` çift süslü ayraçlı yer tutucuları
# sürüm, depo (packaging/release.json) ve SHA256SUMS ile doldurur; çıktı (dist-bin/perafly.rb) tap deposundaki
# Formula/perafly.rb'ye kopyalanır. Bu dosya doğrudan tap'e konmaz.
#
# İkililer: https://github.com/{{REPOSITORY}}/releases/tag/v{{VERSION}}
class Perafly < Formula
  desc "Publish a folder to a live URL and connect agents to it"
  homepage "https://perafly.com"
  version "{{VERSION}}"
  # Lisans ürün sahibinin kararıdır (backend README §14 karar 12); karar verilince `license` satırı eklenir.

  on_macos do
    on_arm do
      url "{{DOWNLOAD_BASE}}/perafly-darwin-arm64"
      sha256 "{{SHA256_DARWIN_ARM64}}"
    end
    on_intel do
      url "{{DOWNLOAD_BASE}}/perafly-darwin-x64"
      sha256 "{{SHA256_DARWIN_X64}}"
    end
  end

  on_linux do
    on_arm do
      url "{{DOWNLOAD_BASE}}/perafly-linux-arm64"
      sha256 "{{SHA256_LINUX_ARM64}}"
    end
    on_intel do
      url "{{DOWNLOAD_BASE}}/perafly-linux-x64"
      sha256 "{{SHA256_LINUX_X64}}"
    end
  end

  def install
    # İndirilen tek dosya ikili `perafly-<os>-<arch>` adıyla gelir
    bin.install Dir["perafly-*"].first => "perafly"
    bin.install_symlink bin/"perafly" => "pf"
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/perafly --version").strip
  end
end
