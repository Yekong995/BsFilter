variable "BUILD_DATE" {
  default = ""
}
variable "GIT_COMMIT" {
  default = ""
}

group "default" {
  targets = ["bsfilter"]
}

target "bsfilter" {
  dockerfile = "Dockerfile"
  tags       = ["bsfilter:${GIT_COMMIT}", "bsfilter:latest", "bsfilter:0.1.0"]
  args = {
    BUILD_DATE = "${BUILD_DATE}"
    GIT_COMMIT = "${GIT_COMMIT}"
  }
}
