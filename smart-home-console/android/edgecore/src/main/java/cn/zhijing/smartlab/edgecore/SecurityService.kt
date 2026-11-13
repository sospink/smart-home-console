package cn.zhijing.smartlab.edgecore

import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Duration
import java.time.Instant
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/**
 * 管理员会话与副屏配对是两条独立信任链。
 * 管理员 PIN 使用 PBKDF2 比对；终端 Bearer 令牌在主屏只保存 SHA-256 摘要。
 */
class SecurityService(
  private val repository: EdgeRepository,
  adminPin: String,
  private val pairingCodeProvider: () -> String,
  private val pairingCodeRotator: () -> Unit = {},
  private val controlDomainId: String = "00000000-0000-4000-8000-000000000000",
  private val controlDomainProofKey: String = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  primaryToken: String? = null,
  private val clock: () -> Instant = Instant::now,
  private val random: SecureRandom = SecureRandom(),
) {
  private val sessions = ConcurrentHashMap<String, Instant>()
  private val eventTickets = ConcurrentHashMap<String, EventTicketIdentity>()
  private val loginAttempts = ConcurrentHashMap<String, AttemptWindow>()
  private val pinChangeAttempts = ConcurrentHashMap<String, AttemptWindow>()
  private val pairingAttempts = ConcurrentHashMap<String, AttemptWindow>()
  private val revokedTerminals = ConcurrentHashMap.newKeySet<String>()
  private val pinSalt = "smart-lab-admin-v1".toByteArray()
  @Volatile private var adminPinHash = pbkdf2(adminPin)
  private val primaryTokenHash = primaryToken?.takeIf(String::isNotBlank)?.let(::hash)

  @Synchronized fun login(pin: String, address: String): AdminSessionDto {
    enforceAttemptWindow(loginAttempts, address)
    if (!MessageDigest.isEqual(pbkdf2(pin), adminPinHash)) {
      recordFailure(loginAttempts, address)
      throw DomainException(401, "INVALID_ADMIN_PIN")
    }
    loginAttempts.remove(address)
    val token = randomToken()
    val expiresAt = clock().plusSeconds(8 * 60 * 60)
    sessions[hash(token)] = expiresAt
    return AdminSessionDto(token, expiresAt.toString())
  }

  /** 持久化成功后才切换内存哈希；任何失败都保留旧 PIN 与旧会话。 */
  @Synchronized
  fun changeAdminPin(request: AdminPinChangeRequestDto, address: String, persist: (String) -> Unit) {
    enforceAttemptWindow(pinChangeAttempts, address)
    if (!MessageDigest.isEqual(pbkdf2(request.currentPin), adminPinHash)) {
      recordFailure(pinChangeAttempts, address)
      throw DomainException(401, "INVALID_CURRENT_ADMIN_PIN")
    }
    if (request.newPin != request.confirmPin) throw DomainException(400, "ADMIN_PIN_CONFIRMATION_MISMATCH")
    val nextHash = pbkdf2(request.newPin)
    if (MessageDigest.isEqual(nextHash, adminPinHash)) throw DomainException(409, "ADMIN_PIN_UNCHANGED")
    if (!request.newPin.matches(Regex("[0-9]{6,12}"))) throw DomainException(400, "INVALID_NEW_ADMIN_PIN")
    persist(request.newPin)
    adminPinHash = nextHash
    sessions.clear()
    loginAttempts.clear()
    pinChangeAttempts.clear()
  }

  fun logout(token: String?) {
    token?.let { sessions.remove(hash(it)) }
  }

  fun isAdmin(token: String?): Boolean {
    if (token.isNullOrBlank()) return false
    val key = hash(token)
    val expiresAt = sessions[key] ?: return false
    if (!expiresAt.isAfter(clock())) {
      sessions.remove(key)
      return false
    }
    return true
  }

  suspend fun pair(request: PairTerminalRequestDto, address: String): PairTerminalResponseDto {
    enforceAttemptWindow(pairingAttempts, address)
    if (!MessageDigest.isEqual(request.pairingCode.toByteArray(), pairingCodeProvider().toByteArray())) {
      recordFailure(pairingAttempts, address)
      throw DomainException(401, "INVALID_PAIRING_CODE")
    }
    pairingAttempts.remove(address)
    if (request.role != "secondary") throw DomainException(400, "只允许配对副屏终端")
    if (!request.deviceId.matches(Regex("[a-zA-Z0-9._-]{6,96}"))) throw DomainException(400, "终端 ID 格式无效")
    val token = randomToken()
    val now = clock().toString()
    val terminal = TerminalDto(
      id = "terminal-${hash(request.deviceId).take(16)}",
      deviceId = request.deviceId,
      name = request.name.ifBlank { "副屏终端" },
      role = "secondary",
      paired = true,
      online = false,
      version = request.version,
      address = address,
      lastSeenAt = now,
    )
    val tokenHash = hash(token)
    repository.saveTerminal(terminal, tokenHash)
    revokedTerminals.remove(terminal.id)
    repository.saveAudit("system", "终端配对", "${terminal.name} (${terminal.deviceId})", "pairing", "success")
    pairingCodeRotator()
    return PairTerminalResponseDto(token, terminal, controlDomainId, derivedControlDomainProofKey(request.deviceId, tokenHash))
  }

  suspend fun authenticateTerminal(token: String?, address: String, version: String = ""): TerminalDto? {
    if (token.isNullOrBlank()) return null
    val presentedHash = hash(token)
    if (primaryTokenHash != null && MessageDigest.isEqual(presentedHash.toByteArray(), primaryTokenHash.toByteArray())) {
      val now = clock().toString()
      val terminal = repository.terminals().firstOrNull { it.role == "primary" }
        ?: TerminalDto(
          id = "terminal-primary",
          deviceId = "primary-runtime",
          name = "实训台主屏",
          role = "primary",
          paired = true,
          online = true,
          version = version,
          address = address,
          lastSeenAt = now,
        )
      repository.updateTerminalContact(terminal.id, address, version, now)
      return terminal.copy(
        address = address,
        version = version.ifBlank { terminal.version },
        lastSeenAt = now,
      )
    }
    val terminal = repository.terminalByTokenHash(presentedHash) ?: return null
    val now = clock().toString()
    repository.updateTerminalContact(terminal.id, address, version, now)
    return terminal.copy(address = address, version = version.ifBlank { terminal.version }, lastSeenAt = now)
  }

  suspend fun issueEventTicket(token: String?, address: String, version: String = ""): EventTicketDto {
    val terminal = authenticateTerminal(token, address, version) ?: throw DomainException(401, "TERMINAL_AUTH_REQUIRED")
    val ticket = randomToken()
    val expiresAt = clock().plusSeconds(60)
    eventTickets[hash(ticket)] = EventTicketIdentity(terminal.id, terminal.role, address, version, expiresAt)
    return EventTicketDto(ticket, expiresAt.toString())
  }

  fun consumeEventTicket(ticket: String?): EventTicketIdentity? {
    if (ticket.isNullOrBlank()) return null
    val identity = eventTickets.remove(hash(ticket)) ?: return null
    return identity.takeIf { it.expiresAt.isAfter(clock()) && !revokedTerminals.contains(it.terminalId) }
  }

  fun revokeEventTickets(terminalId: String) {
    revokedTerminals.add(terminalId)
    eventTickets.entries.removeIf { it.value.terminalId == terminalId }
  }

  fun isTerminalRevoked(terminalId: String) = revokedTerminals.contains(terminalId)

  fun pairingCode() = PairingCodeDto(pairingCodeProvider())

  internal fun hash(value: String): String = MessageDigest.getInstance("SHA-256")
    .digest(value.toByteArray())
    .joinToString("") { "%02x".format(it) }

  /** 撤销会清空 tokenRef，因此旧终端在失去 Bearer 的同时也失去控制域证明能力。 */
  suspend fun activeControlDomainProofKey(deviceId: String): String {
    val proofReference = repository.terminalProofReference(deviceId)
      ?: throw DomainException(401, "CONTROL_DOMAIN_CLIENT_PROOF_REQUIRED")
    return derivedControlDomainProofKey(deviceId, proofReference)
  }

  internal fun derivedControlDomainProofKey(deviceId: String, proofReference: String): String {
    val root = runCatching { Base64.getUrlDecoder().decode(controlDomainProofKey) }
      .getOrElse { throw DomainException(503, "CONTROL_DOMAIN_PROOF_UNAVAILABLE") }
    if (root.size != 32) throw DomainException(503, "CONTROL_DOMAIN_PROOF_UNAVAILABLE")
    val mac = javax.crypto.Mac.getInstance("HmacSHA256").apply {
      init(javax.crypto.spec.SecretKeySpec(root, "HmacSHA256"))
    }
    return Base64.getUrlEncoder().withoutPadding()
      .encodeToString(mac.doFinal("terminal-proof:$deviceId:$proofReference".toByteArray(Charsets.UTF_8)))
  }

  private fun randomToken(): String = ByteArray(32).also(random::nextBytes).let { Base64.getUrlEncoder().withoutPadding().encodeToString(it) }

  private fun pbkdf2(value: String): ByteArray = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
    .generateSecret(PBEKeySpec(value.toCharArray(), pinSalt, 120_000, 256))
    .encoded

  private fun enforceAttemptWindow(store: ConcurrentHashMap<String, AttemptWindow>, address: String) {
    val window = store[address] ?: return
    if (window.blockedUntil?.isAfter(clock()) == true) throw DomainException(429, "TOO_MANY_AUTH_ATTEMPTS")
    if (Duration.between(window.startedAt, clock()).seconds > 10 * 60) store.remove(address)
  }

  private fun recordFailure(store: ConcurrentHashMap<String, AttemptWindow>, address: String) {
    val now = clock()
    store.compute(address) { _, current ->
      val active = current?.takeIf { Duration.between(it.startedAt, now).seconds <= 10 * 60 } ?: AttemptWindow(now, 0)
      val failures = active.failures + 1
      active.copy(failures = failures, blockedUntil = if (failures >= 5) now.plusSeconds(15 * 60) else null)
    }
  }

  private data class AttemptWindow(val startedAt: Instant, val failures: Int, val blockedUntil: Instant? = null)
}

data class EventTicketIdentity(
  val terminalId: String,
  val role: String,
  val address: String,
  val version: String,
  val expiresAt: Instant,
)
