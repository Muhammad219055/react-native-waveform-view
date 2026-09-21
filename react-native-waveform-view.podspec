require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "react-native-waveform-view"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => "13.4" }
  repo_url = package["repository"].is_a?(Hash) ? package["repository"]["url"] : package["repository"]
  s.source       = { :git => repo_url, :tag => "v#{s.version}" }

  s.source_files = "ios/**/*.{h,m,mm}"
  s.frameworks   = "AVFoundation"

  install_modules_dependencies(s)
end
