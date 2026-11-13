plugins {
  alias(libs.plugins.android.library)
  alias(libs.plugins.kotlin.android)
  alias(libs.plugins.kotlin.serialization)
}

android {
  namespace = "cn.zhijing.smartlab.edgecore"
  compileSdk = 35

  defaultConfig { minSdk = 30 }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions { jvmTarget = "17" }
  sourceSets.getByName("test").resources.srcDir("${rootProject.projectDir.parentFile}/packages/contracts/fixtures")
}

dependencies {
  api(project(":gateway-api"))
  implementation(project(":data"))
  implementation(libs.ktor.server.core)
  implementation(libs.ktor.server.cio)
  implementation(libs.ktor.server.content.negotiation)
  implementation(libs.ktor.serialization.json)
  implementation(libs.ktor.server.websockets)
  implementation(libs.ktor.server.cors)
  implementation(libs.ktor.server.status.pages)
  implementation(libs.kotlinx.serialization.json)
  implementation(libs.kotlinx.coroutines.core)
  implementation(libs.tink.android)
  testImplementation(libs.ktor.server.test.host)
  testImplementation(libs.ktor.client.websockets)
  testImplementation(libs.junit)
}
