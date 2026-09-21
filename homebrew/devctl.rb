class Devctl < Formula
  desc "Local development orchestrator"
  homepage "https://github.com/amr-m-abdelgawad/devctl"
  version "0.18.1"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/amr-m-abdelgawad/devctl/releases/download/v#{version}/devctl-darwin-arm64"
      sha256 "7b01e2647d85e2018465814bd75f47b139eebc472234be77a9cca1eb36f35b56"
    else
      url "https://github.com/amr-m-abdelgawad/devctl/releases/download/v#{version}/devctl-darwin-x64"
      sha256 "f25603e0d9f7c30ad415048490576deab682cf05b642f6555650d33fe93d381f"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/amr-m-abdelgawad/devctl/releases/download/v#{version}/devctl-linux-arm64"
      sha256 "91197d62140e8bcefd9ede39c7c314c195d194267dfe687f40f91c9cb3de8e67"
    else
      url "https://github.com/amr-m-abdelgawad/devctl/releases/download/v#{version}/devctl-linux-x64"
      sha256 "fe862408ab307b3b1441fcd7d58681e0e35c819977c1020d51b663489e0777b8"
    end
  end


  def install
    bin.install Dir["devctl*"].first => "devctl"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/devctl version")
  end
end
