package cn.zhijing.smartlab.edgecore

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.encodeToJsonElement

class EdgeEventBus(
  @PublishedApi internal val repository: EdgeRepository,
  @PublishedApi internal val json: Json = Json,
) {
  @PublishedApi internal val mutable = MutableSharedFlow<EdgeEventDto>(extraBufferCapacity = 128)
  val events = mutable.asSharedFlow()

  suspend inline fun <reified T> publish(type: String, payload: T) {
    mutable.emit(EdgeEventDto(type, repository.nextSequence(), json.encodeToJsonElement(payload)))
  }
}
