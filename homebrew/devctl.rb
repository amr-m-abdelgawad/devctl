class Devctl < Formula
  desc "Local development orchestrator"
  homepage "https://github.com/amr-m-abdelgawad/devctl"
  version "0.2.1"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/amr-m-abdelgawad/devctl/releases/download/v#{version}/devctl-darwin-arm64"
      sha256 "c1ac43e9bfead9218683f4a59ac231c5d9bd2336b678e2587e21033f48e6282a"
    else
      url "https://github.com/amr-m-abdelgawad/devctl/releases/download/v#{version}/devctl-darwin-x64"
      sha256 "1558611491f17e6b09b8f8260ce4d10865692afcbdb3181178baf2d69a751f0b"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/amr-m-abdelgawad/devctl/releases/download/v#{version}/devctl-linux-arm64"
      sha256 "6849231a4a52d1023204800854ab36882cd886bff89e2da83479bcde0ef41bf4"
    else
      url "https://github.com/amr-m-abdelgawad/devctl/releases/download/v#{version}/devctl-linux-x64"
      sha256 "7b4db3d649060e7c7a3ebb31379d7e49fb5cc9c6ce5fc8384518c3db299f032a"
    end
  end


  def install
    bin.install Dir["devctl*"].first => "devctl"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/devctl version")
  end
end
