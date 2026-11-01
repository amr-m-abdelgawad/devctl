class Devctl < Formula
  desc "Local development orchestrator"
  homepage "https://github.com/amr-m-abdelgawad/devctl"
  version "0.28.1"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/amr-m-abdelgawad/devctl/releases/download/v#{version}/devctl-darwin-arm64"
      sha256 "12c6cf92c220d7a55be418650c8dfcec47bb5c4adde002ff3a98dc583464b7a3"
    else
      url "https://github.com/amr-m-abdelgawad/devctl/releases/download/v#{version}/devctl-darwin-x64"
      sha256 "1b84d77598573a4f27d9e59f2015130bb8f15dc2f7eff5c863d5008bbe23d623"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/amr-m-abdelgawad/devctl/releases/download/v#{version}/devctl-linux-arm64"
      sha256 "f9ac49b8e2a20f5466ecf6b69f79c3b998a09ded7779859aa3a548454c835a0a"
    else
      url "https://github.com/amr-m-abdelgawad/devctl/releases/download/v#{version}/devctl-linux-x64"
      sha256 "5136d6b6b4f97e9fede5ce913b0b34262c423e2e03c9c1bb0bc18acfb8bcb079"
    end
  end


  def install
    bin.install Dir["devctl*"].first => "devctl"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/devctl version")
  end
end
