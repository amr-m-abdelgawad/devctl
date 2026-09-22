class Devctl < Formula
  desc "Local development orchestrator"
  homepage "https://github.com/amr-m-abdelgawad/devctl"
  version "0.19.1"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/amr-m-abdelgawad/devctl/releases/download/v#{version}/devctl-darwin-arm64"
      sha256 "820ed2f2853dd1d867097d7b9da45cf4095db8dbbeb4d4755a68269285bc941f"
    else
      url "https://github.com/amr-m-abdelgawad/devctl/releases/download/v#{version}/devctl-darwin-x64"
      sha256 "41db253fb92832c91b1856282291951e14714015abca8540b625a887918d0f6a"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/amr-m-abdelgawad/devctl/releases/download/v#{version}/devctl-linux-arm64"
      sha256 "2581d6bbd0352a9704ac64b4e0ed4bcb9cae0d83f386034eb5e1515971bb057f"
    else
      url "https://github.com/amr-m-abdelgawad/devctl/releases/download/v#{version}/devctl-linux-x64"
      sha256 "77d47bf70c81a8932400bb84512c467598e86845fc2608d4bf12a95570908691"
    end
  end


  def install
    bin.install Dir["devctl*"].first => "devctl"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/devctl version")
  end
end
