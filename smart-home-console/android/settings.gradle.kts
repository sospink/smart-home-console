pluginManagement {
  repositories {
    google()
    // 中国大陆环境下 Google Maven TLS 不可达时的受限备用源；禁止代理其他组件组。
    maven("https://maven.aliyun.com/repository/google") {
      content {
        includeGroupByRegex("androidx\\..*")
        includeGroupByRegex("com\\.android\\..*")
        includeGroupByRegex("com\\.google\\..*")
      }
    }
    mavenCentral()
    gradlePluginPortal()
  }
}

dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories {
    google()
    mavenCentral()
  }
}

rootProject.name = "SmartLabConsole"
include(":app", ":edgecore", ":data", ":gateway-api", ":gateway-home-assistant")
