package cn.zhijing.smartlab.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** 密文可入数据库，密钥只存在 Android Keystore；诊断与备份禁止导出 [EncryptedValue] 内容。 */
class SecretStore(private val alias: String = "smart-lab-edge-secrets-v1") {
  private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  fun encrypt(plainText: String): EncryptedValue {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, secretKey())
    return EncryptedValue(
      cipherText = cipher.doFinal(plainText.toByteArray(Charsets.UTF_8)),
      initializationVector = cipher.iv,
    )
  }

  fun decrypt(value: EncryptedValue): String {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, value.initializationVector))
    return cipher.doFinal(value.cipherText).toString(Charsets.UTF_8)
  }

  fun removeKey() = keyStore.deleteEntry(alias)

  private fun secretKey(): SecretKey {
    (keyStore.getKey(alias, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setRandomizedEncryptionRequired(true)
        .build()
    )
    return generator.generateKey()
  }

  companion object {
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
  }
}

data class EncryptedValue(val cipherText: ByteArray, val initializationVector: ByteArray)

/**
 * 将终端令牌、网关 Token/Key 以 Keystore 密钥加密后持久化。
 * SharedPreferences 中只存 IV 和密文，日志、诊断包和配置备份不得读取该文件。
 */
class PersistentSecretStore(
  context: Context,
  private val crypto: SecretStore = SecretStore(),
) {
  private val preferences = context.getSharedPreferences("smart-lab-secrets", Context.MODE_PRIVATE)

  fun put(reference: String, value: String) {
    require(reference.matches(Regex("[a-zA-Z0-9._-]{1,96}"))) { "密钥引用格式无效" }
    val encrypted = crypto.encrypt(value)
    val encoded = "${Base64.encodeToString(encrypted.initializationVector, Base64.NO_WRAP)}.${Base64.encodeToString(encrypted.cipherText, Base64.NO_WRAP)}"
    check(preferences.edit().putString(reference, encoded).commit()) { "密文持久化失败" }
  }

  fun get(reference: String): String? {
    val encoded = preferences.getString(reference, null) ?: return null
    val parts = encoded.split('.', limit = 2)
    if (parts.size != 2) return null
    return runCatching {
      crypto.decrypt(
        EncryptedValue(
          cipherText = Base64.decode(parts[1], Base64.NO_WRAP),
          initializationVector = Base64.decode(parts[0], Base64.NO_WRAP),
        )
      )
    }.getOrNull()
  }

  fun getOrCreate(reference: String, factory: () -> String): String = get(reference) ?: factory().also { put(reference, it) }

  fun remove(reference: String) = preferences.edit().remove(reference).apply()
}
