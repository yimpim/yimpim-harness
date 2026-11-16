/**
 * Kotlin models for the YIMPIM remote-control wire protocol.
 * Companion to docs/REMOTE_SPEC.md — read that first, this implements it.
 *
 * Reference implementation this was verified against: src/remote/protocol.ts,
 * src/remote/broker.ts, src/remote/client.ts.
 *
 * Requires: kotlinx-serialization-json. Written for Android specifically
 * (uses android.util.Base64, which is more lenient with the unpadded
 * base64url the desktop emits than java.util.Base64 is) — port the two
 * Base64 calls in YimpimCrypto if you ever need this on plain JVM instead.
 *
 * NOT covered here, because the protocol doesn't have them (see
 * REMOTE_SPEC.md's opening section for why): a diff/patch CONTENT payload
 * (FileChangedEvent below has real added/removed line counts, but never the
 * actual before/after text), a streaming per-call token-cost event, and a
 * distinct "checkpoint" question type. Every question — blocking, approval,
 * or otherwise — is one PendingQuestion inside a StatusEvent.
 */
package com.yimpim.remote

import android.util.Base64
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonContentPolymorphicSerializer
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.serializer
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import java.security.SecureRandom

// =====================================================================
// Envelope — the outer, always-visible wire shape. `data`+`tag` decrypt
// (via YimpimCrypto below) to one of the RemoteEvent subtypes.
// =====================================================================

@Serializable
data class Envelope(
    val v: Int,
    val sessionId: String,
    val seq: Long,
    /** base64 (standard alphabet, NOT url-safe), 12 raw bytes. */
    val iv: String,
    /** base64 (standard alphabet), ciphertext only — tag is separate. */
    val data: String,
    /** base64 (standard alphabet), 16 raw bytes. */
    val tag: String
)

// =====================================================================
// Pairing — decoding the QR code fragment. Note: base64URL here, not the
// standard alphabet Envelope's fields use — mixing these up silently
// corrupts the session key.
// =====================================================================

data class PairingPayload(
    val v: Int,
    val sessionId: String,
    /** One-time secret to redeem via POST /v1/pair. Never hash this
     *  yourself — the broker hashes it server-side; send it raw. */
    val pairing: String,
    /** base64url-encoded 32-byte AES-256-GCM session key. */
    val key: String
)

/** `fragment` is everything after the `#` in the scanned QR URL, e.g.
 *  "1.s_AbCdEf.pR3q...xY9z". Throws IllegalArgumentException on a
 *  malformed or version-mismatched fragment. */
fun decodePairing(fragment: String): PairingPayload {
    val parts = fragment.split(".")
    require(parts.size == 4) { "pairing payload is malformed" }
    val (vStr, sessionId, pairing, key) = parts
    val v = vStr.toIntOrNull() ?: throw IllegalArgumentException("pairing payload is malformed")
    require(v == PROTOCOL_VERSION) { "pairing payload version mismatch: got $v, expected $PROTOCOL_VERSION" }
    return PairingPayload(v, sessionId, pairing, key)
}

/** Decodes the base64url session key out of a PairingPayload into raw
 *  key bytes ready for YimpimCrypto. */
fun PairingPayload.sessionKeyBytes(): ByteArray =
    Base64.decode(key, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

const val PROTOCOL_VERSION = 1

// =====================================================================
// Crypto — AES-256-GCM seal/open, interoperable with protocol.ts's
// seal()/open(). THE ONE THING TO GET EXACTLY RIGHT: Node keeps
// ciphertext and the GCM auth tag as two separate values; Java's Cipher
// expects them concatenated (tag appended to the ciphertext) for
// doFinal(). Get this wrong and every decrypt throws AEADBadTagException.
// =====================================================================

object YimpimCrypto {
    private const val TRANSFORM = "AES/GCM/NoPadding"
    private const val TAG_LENGTH_BITS = 128 // 16 bytes — must match Node's default GCM tag length

    private fun aad(v: Int, sessionId: String, seq: Long): ByteArray =
        "$v:$sessionId:$seq".toByteArray(Charsets.UTF_8)

    /** Decrypts an Envelope's plaintext JSON string. Throws
     *  javax.crypto.AEADBadTagException if the key is wrong OR if the
     *  envelope was tampered with / routed to the wrong session. */
    fun open(key: ByteArray, envelope: Envelope): String {
        val iv = Base64.decode(envelope.iv, Base64.NO_WRAP)
        val cipherBytes = Base64.decode(envelope.data, Base64.NO_WRAP)
        val tagBytes = Base64.decode(envelope.tag, Base64.NO_WRAP)

        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(
            Cipher.DECRYPT_MODE,
            SecretKeySpec(key, "AES"),
            GCMParameterSpec(TAG_LENGTH_BITS, iv)
        )
        cipher.updateAAD(aad(envelope.v, envelope.sessionId, envelope.seq))

        // Java's GCM decrypt wants ciphertext and tag as ONE buffer, tag last.
        val combined = cipherBytes + tagBytes
        val plaintext = cipher.doFinal(combined)
        return String(plaintext, Charsets.UTF_8)
    }

    /** Encrypts a plaintext JSON string into an Envelope ready to embed in
     *  an outbound POST /v1/command body. `seq` must be strictly
     *  increasing per session — track your own counter, starting wherever
     *  makes sense for a device (the desktop and device count independently;
     *  the broker only cares that a given session+seq pair is never reused
     *  for genuinely different content, which AAD binding enforces). */
    fun seal(key: ByteArray, sessionId: String, seq: Long, plaintextJson: String, v: Int = PROTOCOL_VERSION): Envelope {
        val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }

        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(
            Cipher.ENCRYPT_MODE,
            SecretKeySpec(key, "AES"),
            GCMParameterSpec(TAG_LENGTH_BITS, iv)
        )
        cipher.updateAAD(aad(v, sessionId, seq))

        // Java's GCM encrypt output is ciphertext+tag concatenated — split
        // it back into Node's separate data/tag fields.
        val combined = cipher.doFinal(plaintextJson.toByteArray(Charsets.UTF_8))
        val cipherBytes = combined.copyOfRange(0, combined.size - 16)
        val tagBytes = combined.copyOfRange(combined.size - 16, combined.size)

        return Envelope(
            v = v,
            sessionId = sessionId,
            seq = seq,
            iv = Base64.encodeToString(iv, Base64.NO_WRAP),
            data = Base64.encodeToString(cipherBytes, Base64.NO_WRAP),
            tag = Base64.encodeToString(tagBytes, Base64.NO_WRAP)
        )
    }
}

// =====================================================================
// Status snapshot & the ONE question shape (no separate "checkpoint" type)
// =====================================================================

/**
 * `kind` distinguishes a blocking clarification from an approval prompt,
 * but the WIRE SHAPE is identical either way — render one generic
 * question UI, branch on `kind` only for cosmetic treatment (e.g. showing
 * approve/reject buttons for "approval" vs a text field for "blocking").
 */
@Serializable
enum class QuestionKind {
    @SerialName("blocking") BLOCKING,
    @SerialName("deferred") DEFERRED,
    @SerialName("approval") APPROVAL
}

@Serializable
data class PendingQuestion(
    val id: String,
    val kind: QuestionKind,
    val prompt: String,
    /** Suggested answers; absent or empty means free text only. */
    val choices: List<String>? = null,
    /** Applied server-side if this question times out with no answer. */
    val fallback: String,
    val askedAt: String
)

@Serializable
data class PhaseEntry(
    val id: String,
    val name: String,
    /** Free-form on purpose — "pending"/"running"/"passed"/"failed" are
     *  what's actually produced today, but this is NOT a closed enum in
     *  the source protocol; a future desktop version could add a value
     *  an older Android build has never seen. Match on known strings,
     *  fall back to a generic "unknown" treatment for anything else. */
    val status: String
)

@Serializable
data class RemoteStatus(
    val runId: String,
    val repoName: String,
    /** Same "don't hard-enum an external protocol's string field" reasoning
     *  as PhaseEntry.status — known values today: idle, planning, running,
     *  awaiting-input, done, failed, aborted. */
    val state: String,
    val goal: String? = null,
    val phases: List<PhaseEntry> = emptyList(),
    val currentPhase: String? = null,
    val pendingQuestions: List<PendingQuestion> = emptyList(),
    val tokensUsed: Long = 0,
    val startedAt: String,
    val updatedAt: String
)

// =====================================================================
// Inbound events (desktop -> device). Decrypted plaintext is a FLAT
// object — {"kind": "...", "at": "...", ...fields} — not a wrapped
// {"type": X, "value": Y} shape, so ordinary sealed-class polymorphism
// doesn't apply. JsonContentPolymorphicSerializer below inspects "kind"
// and picks the right subtype's own deserializer.
// =====================================================================

sealed class RemoteEvent {
    abstract val at: String
}

@Serializable
data class StatusEvent(val at: String, val status: RemoteStatus) : RemoteEvent()

@Serializable
data class LogEvent(val at: String, val level: String, val message: String) : RemoteEvent()

@Serializable
data class ScreenshotChunkEvent(
    val at: String,
    val id: String,
    val label: String,
    val mime: String,
    val seq: Int,
    val total: Int,
    /** base64 chunk of the image; concatenate by seq order across every
     *  chunk sharing `id` until you have `total` chunks, then base64-decode
     *  the WHOLE concatenated string once — not each chunk individually. */
    val data: String
) : RemoteEvent()

@Serializable
data class CommandRefusedEvent(val at: String, val verb: String, val reason: String) : RemoteEvent()

@Serializable
data class CommandAcceptedEvent(val at: String, val verb: String) : RemoteEvent()

@Serializable
data class AnswerRejectedEvent(val at: String, val questionId: String, val reason: String) : RemoteEvent()

@Serializable
data class AttachDoneEvent(val at: String, val name: String, val bytes: Long) : RemoteEvent()

@Serializable
data class AttachRejectedEvent(val at: String, val reason: String) : RemoteEvent()

@Serializable
data class PongEvent(val at: String) : RemoteEvent()

@Serializable
data class SessionEndEvent(val at: String, val reason: String) : RemoteEvent()

/** A worker (EDITOR/REPAIR/QA/...) started its pass on the current phase.
 *  `phaseId`/`phaseName`/`acceptanceCriteria` are absent if the desktop had
 *  no current phase in scope at the moment this fired — don't assume
 *  they're always present. `acceptanceCriteria` is the Planner's own
 *  verification list for that phase, written the way a human would phrase
 *  a story's acceptance criteria. */
@Serializable
data class WorkerStartEvent(
    val at: String,
    val agent: String,
    val phaseId: String? = null,
    val phaseName: String? = null,
    val acceptanceCriteria: List<String>? = null
) : RemoteEvent()

/** `outcome` is free-form ("completed", "passed", "failed",
 *  "circuit_breaker", "turn_limit") — treat as open, not a closed enum. */
@Serializable
data class WorkerEndEvent(val at: String, val agent: String, val outcome: String) : RemoteEvent()

/** One successful write_file/patch_file tool call. `action` is "created"
 *  only for a brand-new file written via write_file — patch_file is always
 *  "modified" (patching a nonexistent file fails before this would fire).
 *  For a patch, added/removed cover only the changed search/replace region,
 *  not a full old-file-vs-new-file comparison. */
@Serializable
data class FileChangedEvent(
    val at: String,
    val agent: String,
    val path: String,
    val action: String,
    val added: Int,
    val removed: Int
) : RemoteEvent()

/** One entry from QA's evidence ledger — NOT test-runner output. YIMPIM's QA
 *  is its own PASS/DEFECT/INCONCLUSIVE-per-requirement system; `gate` is a
 *  human-readable check name ("compile/build", "requirement coverage",
 *  "RaceScreen visual QA"), never a named unit test. Only `blocking == true`
 *  combined with `status == "fail"` can fail the phase — `status == "error"`
 *  means the CHECK itself broke, never the code under test. `artifacts`,
 *  when present, are screenshot filenames also reachable via
 *  ScreenshotChunkEvent from the same run (correlate by filename; no shared
 *  id). `tier` is one of build/runtime/visual/static/semantic; `status` is
 *  one of pass/fail/skipped/inconclusive/error — both free-form strings in
 *  this model for the same forward-compatibility reasons as PhaseEntry.status. */
@Serializable
data class GateResultEvent(
    val at: String,
    val tier: String,
    val gate: String,
    val status: String,
    val blocking: Boolean,
    val detail: String,
    val artifacts: List<String>? = null
) : RemoteEvent()

/** QA's final roll-up for the phase, fired once right before QA's own
 *  WorkerEndEvent. blockingFailures/advisories are pre-formatted
 *  "gate: detail" strings, not structured entries — use the GateResultEvents
 *  that already fired for the individual tier/gate/status fields instead of
 *  re-parsing these. confidence is one of verified/partial/static-only. */
@Serializable
data class VerdictEvent(
    val at: String,
    val passed: Boolean,
    val confidence: String,
    val blockingFailures: List<String> = emptyList(),
    val advisories: List<String> = emptyList()
) : RemoteEvent()

/** Anything with an unrecognized `kind` — a newer desktop build added an
 *  event type this client doesn't know about yet. Never crash on this;
 *  the raw JSON is preserved in case a caller wants to log it. */
data class UnknownEvent(override val at: String, val kind: String, val raw: JsonObject) : RemoteEvent()

object RemoteEventSerializer : JsonContentPolymorphicSerializer<RemoteEvent>(RemoteEvent::class) {
    // The explicit return type here is load-bearing, not stylistic: each `when`
    // branch returns a differently-parameterized KSerializer<X> (KSerializer is
    // invariant in kotlinx.serialization), so without a declared expected type
    // Kotlin cannot infer a common type across the branches and this fails to
    // compile. Declaring DeserializationStrategy<out RemoteEvent> makes Kotlin
    // check each branch against that target type individually instead.
    override fun selectDeserializer(element: JsonElement): DeserializationStrategy<out RemoteEvent> = try {
        when (element.jsonObject["kind"]?.jsonPrimitive?.content) {
            "status" -> StatusEvent.serializer()
            "log" -> LogEvent.serializer()
            "screenshot.chunk" -> ScreenshotChunkEvent.serializer()
            "command.refused" -> CommandRefusedEvent.serializer()
            "command.accepted" -> CommandAcceptedEvent.serializer()
            "answer.rejected" -> AnswerRejectedEvent.serializer()
            "attach.done" -> AttachDoneEvent.serializer()
            "attach.rejected" -> AttachRejectedEvent.serializer()
            "pong" -> PongEvent.serializer()
            "session.end" -> SessionEndEvent.serializer()
            "worker.start" -> WorkerStartEvent.serializer()
            "worker.end" -> WorkerEndEvent.serializer()
            "file.changed" -> FileChangedEvent.serializer()
            "gate.result" -> GateResultEvent.serializer()
            "verdict" -> VerdictEvent.serializer()
            else -> UnknownEventSerializer
        }
    } catch (e: Exception) {
        UnknownEventSerializer
    }
}

/** Hand-rolled rather than @Serializable, since UnknownEvent needs to
 *  capture the whole raw object rather than a fixed field set. */
private object UnknownEventSerializer : KSerializer<UnknownEvent> {
    override val descriptor = JsonObject.serializer().descriptor
    override fun deserialize(decoder: Decoder): UnknownEvent {
        val input = decoder as? JsonDecoder
            ?: throw IllegalStateException("UnknownEvent only supports JSON decoding")
        val obj = input.decodeJsonElement().jsonObject
        return UnknownEvent(
            at = obj["at"]?.jsonPrimitive?.content ?: "",
            kind = obj["kind"]?.jsonPrimitive?.content ?: "unknown",
            raw = obj
        )
    }
    override fun serialize(encoder: Encoder, value: UnknownEvent) {
        throw UnsupportedOperationException("UnknownEvent is inbound-only, never sent")
    }
}

/** Decrypt + parse one Envelope into a typed RemoteEvent in one call. */
fun decodeEvent(key: ByteArray, envelope: Envelope, json: Json = Json { ignoreUnknownKeys = true }): RemoteEvent {
    val plaintext = YimpimCrypto.open(key, envelope)
    return json.decodeFromString(RemoteEventSerializer, plaintext)
}

// =====================================================================
// Outbound commands (device -> desktop). Each is a PLAIN flat data
// class with its own literal "verb" field — deliberately NOT modeled as
// serializable sealed-class polymorphism, since that would wrap output
// in kotlinx's own {"type": ..., ...} shape instead of the flat
// {"verb": "answer", ...} shape the desktop actually expects. Build the
// concrete class you want to send and pass it straight to buildCommand().
// =====================================================================

sealed interface RemoteVerb

@Serializable
data class AbortVerb(val verb: String = "abort", val reason: String? = null) : RemoteVerb

@Serializable
data class PingVerb(val verb: String = "ping") : RemoteVerb

@Serializable
data class AnswerVerb(val verb: String = "answer", val questionId: String, val answer: String) : RemoteVerb

@Serializable
data class ApproveVerb(val verb: String = "approve", val questionId: String) : RemoteVerb

@Serializable
data class RejectVerb(val verb: String = "reject", val questionId: String, val reason: String? = null) : RemoteVerb

/**
 * Free text with no questionId — the "start a task from the phone" verb.
 * Applied to whatever question the desktop asks next (immediately, if one
 * is already pending; otherwise queued). Never interrupts a phase in
 * flight — see REMOTE_SPEC.md section 6.
 */
@Serializable
data class MessageVerb(val verb: String = "message", val text: String) : RemoteVerb

/** One 48KB-raw chunk of a file being handed over as reference material.
 *  Limits: 10 MB per file, 40 MB per session total, enforced server-side —
 *  handle an attach.rejected event for either case. */
@Serializable
data class AttachVerb(
    val verb: String = "attach",
    val uploadId: String,
    val name: String,
    val mime: String,
    val seq: Int,
    val total: Int,
    val data: String
) : RemoteVerb

@Serializable
data class OutboundCommand(
    val id: String,
    val issuedAt: String,
    val deviceId: String,
    val payload: JsonElement
)

/** Wraps one RemoteVerb into the {id, issuedAt, deviceId, payload} shape
 *  the desktop expects, ready to JSON-encode and pass to YimpimCrypto.seal().
 *  java.time.Instant needs minSdk 26+ or core library desugaring enabled —
 *  swap for any other ISO-8601 source if your app targets lower than that. */
inline fun <reified T : RemoteVerb> buildCommand(deviceId: String, verb: T, json: Json = Json): OutboundCommand {
    return OutboundCommand(
        id = "c_" + randomId(),
        issuedAt = java.time.Instant.now().toString(),
        deviceId = deviceId,
        payload = json.encodeToJsonElement(serializer<T>(), verb)
    )
}

/** Not cryptographically important (unlike the session key) — this only
 *  needs to be unique enough that the desktop's replay-guard (dedup by
 *  exact id string) never sees a collision from this device. */
fun randomId(): String {
    val bytes = ByteArray(9).also { SecureRandom().nextBytes(it) }
    return Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
}

// =====================================================================
// Usage sketch (not exhaustive — see REMOTE_SPEC.md for the full HTTP flow)
// =====================================================================
//
// val pairing = decodePairing(scannedFragment)
// val key = pairing.sessionKeyBytes()
// // POST pairing.sessionId + pairing.pairing to /v1/pair -> deviceToken, deviceId
//
// // Poll loop:
// // GET /v1/stream?sessionId=...&after=lastSeq, Authorization: Bearer deviceToken
// // -> { "events": [Envelope, ...] }
// for (envelope in response.events) {
//     when (val event = decodeEvent(key, envelope)) {
//         is StatusEvent -> render(event.status)
//         is LogEvent -> appendToLog(event.level, event.message)
//         is ScreenshotChunkEvent -> accumulateChunk(event)
//         // clearSavedSession() means the device token + session key ONLY — an
//         // ended session's credentials are permanently dead. It does NOT mean
//         // wiping any locally-rendered task/event history: the desktop keeps
//         // its own durable history and replays it into the next session you
//         // pair, through this same event stream, so history survives a
//         // desktop restart or a fresh re-pair as long as YOUR local render
//         // isn't the thing that throws it away first. See REMOTE_SPEC.md's
//         // "History across sessions" section.
//         is SessionEndEvent -> { stopPolling(); clearSavedSession() } // credentials only, see spec
//         is WorkerStartEvent -> openWorkerCard(event) // buffer FileChangedEvent/GateResultEvent until the matching WorkerEndEvent
//         is WorkerEndEvent -> closeWorkerCard(event)
//         is FileChangedEvent -> appendFileChangeRow(event)
//         is GateResultEvent -> appendGateRow(event) // not a named test — see the class doc
//         is VerdictEvent -> showVerdictBanner(event)
//         is UnknownEvent -> {} // forward-compatible no-op
//         else -> {}
//     }
//     lastSeq = maxOf(lastSeq, envelope.seq)
// }
//
// // Sending an answer:
// val cmd = buildCommand(deviceId, AnswerVerb(questionId = q.id, answer = "Yes, do that"))
// val envelope = YimpimCrypto.seal(key, sessionId, nextOutboundSeq++, Json.encodeToString(cmd))
// // POST { sessionId, envelope } to /v1/command, Authorization: Bearer deviceToken
