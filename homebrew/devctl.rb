class Devctl < Formula
  desc "Local development orchestrator"
  homepage "https://github.com/amr-m-abdelgawad/devctl"
  version "0.10.0"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/amr-m-abdelgawad/devctl/releases/download/v#{version}/devctl-darwin-arm64"
      sha256 "790ec67fca1fd9bcd7d10064dc46472976b0b2fa22dbd72f9f7e0992dad6ce86"
    else
      url "https://github.com/amr-m-abdelgawad/devctl/releases/download/v#{version}/devctl-darwin-x64"
      sha256 "e662f263e164b98ec951865f2c96da512fd8801e63ce70932389d688abdefab3"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/amr-m-abdelgawad/devctl/releases/download/v#{version}/devctl-linux-arm64"
      sha256 "c95d06438a185ef5558dd23a7c72036c51c46fee6d8042513c7dfa94f5b0f7ed"
    else
      url "https://github.com/amr-m-abdelgawad/devctl/releases/download/v#{version}/devctl-linux-x64"
      sha256 "cc628180a6dca5366c44806cbea0f73137174cf914ee81dcf2a3c22771c4ed89"
    end
  end


  def install
    bin.install Dir["devctl*"].first => "devctl"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/devctl version")
  end
end
