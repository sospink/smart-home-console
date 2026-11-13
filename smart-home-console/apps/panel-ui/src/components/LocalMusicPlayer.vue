<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Music2, Pause, Play, Power, SkipBack, SkipForward, Volume2 } from "lucide-vue-next";

const props = defineProps<{
  enabled: boolean;
  volume: number;
  deviceName?: string;
  unavailable?: boolean;
  powerPending?: boolean;
  volumePending?: boolean;
}>();

const emit = defineEmits<{
  "power:toggle": [];
  "volume:change": [value: number];
}>();

const tracks = [
  { title: "晨光慢行", artist: "知境·本地音源", src: `${import.meta.env.BASE_URL}audio/morning-light.mp3`, tone: "morning" },
  { title: "安静夜色", artist: "知境·本地音源", src: `${import.meta.env.BASE_URL}audio/quiet-night.mp3`, tone: "night" },
  { title: "微风客厅", artist: "知境·本地音源", src: `${import.meta.env.BASE_URL}audio/soft-breeze.mp3`, tone: "breeze" }
] as const;

const audio = ref<HTMLAudioElement>();
const trackIndex = ref(0);
const playing = ref(false);
const ready = ref(false);
const playbackError = ref("");
const currentTime = ref(0);
const duration = ref(0);
const volumeDraft = ref(props.volume);
const volumeDragging = ref(false);
const unlocked = ref(false);
const resumeAfterPowerOn = ref(false);
const currentTrack = computed(() => tracks[trackIndex.value]);
const progress = computed(() => (duration.value > 0 ? (currentTime.value / duration.value) * 100 : 0));
const statusText = computed(() => {
  if (props.unavailable) return "连接已断开·控制只读";
  if (playbackError.value) return playbackError.value;
  if (!props.enabled) return "音乐主机已关闭";
  if (!ready.value) return "本地音源加载中";
  return playing.value ? "正在播放·本地音源" : "已就绪·点击播放";
});

watch(
  () => props.volume,
  (value) => {
    if (!volumeDragging.value) volumeDraft.value = value;
    if (audio.value) audio.value.volume = Math.min(1, Math.max(0, value / 100));
  },
  { immediate: true }
);
watch(
  () => props.volumePending,
  (pending, previous) => {
    if (previous && !pending && !volumeDragging.value) {
      volumeDraft.value = props.volume;
      if (audio.value) audio.value.volume = Math.min(1, Math.max(0, props.volume / 100));
    }
  }
);

watch(
  () => props.enabled,
  (enabled) => {
    if (!enabled) {
      resumeAfterPowerOn.value = playing.value;
      pauseAudio();
    } else if (unlocked.value && resumeAfterPowerOn.value) {
      void playAudio();
    }
  }
);

watch(
  () => props.unavailable,
  (unavailable) => {
    if (unavailable) {
      resumeAfterPowerOn.value = playing.value;
      pauseAudio();
    }
  }
);

function formatTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const minutes = Math.floor(value / 60);
  return `${minutes}:${Math.floor(value % 60)
    .toString()
    .padStart(2, "0")}`;
}

function syncMetadata() {
  if (!audio.value) return;
  duration.value = Number.isFinite(audio.value.duration) ? audio.value.duration : 0;
  ready.value = true;
  audio.value.volume = Math.min(1, Math.max(0, volumeDraft.value / 100));
}

function syncTime() {
  currentTime.value = audio.value?.currentTime ?? 0;
}

async function playAudio() {
  if (!audio.value || props.unavailable) return;
  unlocked.value = true;
  playbackError.value = "";
  if (!props.enabled) emit("power:toggle");
  try {
    await audio.value.play();
    playing.value = true;
    resumeAfterPowerOn.value = true;
  } catch {
    playing.value = false;
    playbackError.value = "播放被系统拦截，请再点一次";
  }
}

function pauseAudio() {
  audio.value?.pause();
  playing.value = false;
}

function togglePlayback() {
  if (props.unavailable) return;
  if (playing.value) {
    resumeAfterPowerOn.value = false;
    pauseAudio();
  } else {
    void playAudio();
  }
}

async function changeTrack(offset: number) {
  if (props.unavailable) return;
  const shouldResume = playing.value;
  trackIndex.value = (trackIndex.value + offset + tracks.length) % tracks.length;
  currentTime.value = 0;
  duration.value = 0;
  ready.value = false;
  playbackError.value = "";
  await nextTick();
  audio.value?.load();
  if (shouldResume) void playAudio();
}

function seek(event: Event) {
  if (!audio.value || props.unavailable) return;
  const value = Number((event.target as HTMLInputElement).value);
  audio.value.currentTime = value;
  currentTime.value = value;
}

function previewVolume(event: Event) {
  if (props.unavailable) return;
  volumeDragging.value = true;
  const value = Number((event.target as HTMLInputElement).value);
  volumeDraft.value = value;
  if (audio.value) audio.value.volume = value / 100;
}

function commitVolume() {
  if (props.unavailable) return;
  volumeDragging.value = false;
  if (volumeDraft.value !== props.volume) emit("volume:change", volumeDraft.value);
}

function cancelVolumePreview() {
  if (!volumeDragging.value) return;
  volumeDragging.value = false;
  volumeDraft.value = props.volume;
  if (audio.value) audio.value.volume = Math.min(1, Math.max(0, props.volume / 100));
}

function togglePower() {
  if (props.unavailable) return;
  if (props.enabled) {
    resumeAfterPowerOn.value = playing.value;
    pauseAudio();
  }
  emit("power:toggle");
}
</script>

<template>
  <section class="local-player" :class="[{ playing, disabled: !enabled, unavailable }, `tone-${currentTrack.tone}`]">
    <audio
      ref="audio"
      :src="currentTrack.src"
      preload="metadata"
      @loadedmetadata="syncMetadata"
      @canplay="ready = true"
      @timeupdate="syncTime"
      @play="playing = true"
      @pause="playing = false"
      @ended="changeTrack(1)"
      @error="playbackError = '本地音源加载失败'"
    />

    <div class="album-art" aria-hidden="true">
      <span class="record"><i /><Music2 :size="21" /></span>
      <span class="sound-bars"><i v-for="index in 5" :key="index" /></span>
    </div>

    <div class="track-copy">
      <span>客厅·{{ statusText }}</span>
      <h1>{{ currentTrack.title }}</h1>
      <p>
        {{ currentTrack.artist }}<template v-if="deviceName"> · {{ deviceName }}</template>
      </p>
    </div>

    <button
      v-ripple
      class="speaker-power"
      :class="{ active: enabled }"
      :aria-label="`背景音乐${enabled ? '关闭' : '开启'}`"
      :disabled="unavailable || powerPending"
      @click="togglePower"
    >
      <Power :size="18" />
    </button>

    <div class="timeline">
      <input
        aria-label="音乐播放进度"
        type="range"
        min="0"
        :max="duration || 0"
        step="0.1"
        :value="currentTime"
        :style="{ '--progress': `${progress}%` }"
        :disabled="!ready || unavailable"
        @input="seek"
      />
      <span>{{ formatTime(currentTime) }}</span
      ><span>{{ formatTime(duration) }}</span>
    </div>

    <div class="transport-controls">
      <button v-ripple aria-label="上一首" :disabled="unavailable" @click="changeTrack(-1)">
        <SkipBack :size="19" />
      </button>
      <button
        v-ripple
        class="primary-play"
        :class="{ active: playing }"
        :aria-label="playing ? '暂停音乐' : '播放音乐'"
        :disabled="unavailable || powerPending"
        @click="togglePlayback"
      >
        <Pause v-if="playing" :size="22" />
        <Play v-else :size="22" />
      </button>
      <button v-ripple aria-label="下一首" :disabled="unavailable" @click="changeTrack(1)">
        <SkipForward :size="19" />
      </button>
    </div>

    <div class="volume-control">
      <Volume2 :size="16" />
      <input
        aria-label="背景音乐音量"
        type="range"
        min="0"
        max="100"
        :value="volumeDraft"
        :style="{ '--progress': `${volumeDraft}%` }"
        :disabled="unavailable || volumePending"
        @input="previewVolume"
        @change="commitVolume"
        @pointercancel="cancelVolumePreview"
      />
      <strong>{{ volumeDraft }}%</strong>
    </div>
  </section>
</template>

<style scoped>
.local-player {
  position: absolute;
  inset: 0;
  display: grid;
  grid-template-columns: 112px minmax(0, 1fr) 44px;
  grid-template-rows: 102px 38px 62px 34px;
  column-gap: 20px;
  align-content: center;
  padding: 24px 30px;
  overflow: hidden;
  isolation: isolate;
}
.local-player::before {
  content: "";
  position: absolute;
  z-index: -1;
  width: 330px;
  height: 330px;
  top: -170px;
  left: -100px;
  border-radius: 50%;
  opacity: 0.68;
  background: radial-gradient(circle, rgba(77, 156, 255, 0.24), transparent 66%);
  transition: background 500ms ease;
}
.tone-night::before {
  background: radial-gradient(circle, rgba(125, 105, 255, 0.24), transparent 66%);
}
.tone-breeze::before {
  background: radial-gradient(circle, rgba(45, 199, 176, 0.22), transparent 66%);
}
.local-player audio {
  display: none;
}
.album-art {
  position: relative;
  grid-row: 1 / 3;
  display: grid;
  place-items: center;
  width: 112px;
  height: 112px;
  align-self: center;
  border-radius: 30px;
  background: linear-gradient(145deg, color-mix(in srgb, var(--selected) 72%, #fff), var(--card));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--cyan) 12%, transparent);
  overflow: hidden;
}
.record {
  position: relative;
  width: 70px;
  height: 70px;
  display: grid;
  place-items: center;
  color: #fff;
  border-radius: 50%;
  background:
    repeating-radial-gradient(circle, transparent 0 5px, rgba(255, 255, 255, 0.13) 6px 7px),
    linear-gradient(145deg, #5dbdff, #4c78df 56%, #7662da);
  box-shadow: 0 12px 26px rgba(61, 115, 198, 0.2);
}
.record i {
  position: absolute;
  inset: 27px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.2);
}
.record svg {
  z-index: 1;
}
.playing .record {
  animation: record-spin 7s linear infinite;
}
.sound-bars {
  position: absolute;
  right: 11px;
  bottom: 13px;
  height: 22px;
  display: flex;
  align-items: flex-end;
  gap: 2px;
}
.sound-bars i {
  width: 2px;
  height: 24%;
  border-radius: 2px;
  background: var(--cyan);
}
.playing .sound-bars i {
  animation: music-meter 720ms ease-in-out infinite alternate;
}
.playing .sound-bars i:nth-child(2) {
  animation-delay: -430ms;
}
.playing .sound-bars i:nth-child(3) {
  animation-delay: -210ms;
}
.playing .sound-bars i:nth-child(4) {
  animation-delay: -560ms;
}
.playing .sound-bars i:nth-child(5) {
  animation-delay: -100ms;
}
.track-copy {
  min-width: 0;
  align-self: center;
}
.track-copy > span {
  color: var(--muted);
  font-size: 8px;
  letter-spacing: 0.08em;
}
.track-copy h1 {
  margin: 10px 0 6px;
  color: var(--text);
  font-size: 23px;
  font-weight: 580;
  letter-spacing: -0.025em;
}
.track-copy p {
  margin: 0;
  overflow: hidden;
  color: var(--muted);
  font-size: 9px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.speaker-power {
  align-self: start;
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  color: var(--muted);
  background: var(--control);
  border-radius: 50%;
}
.speaker-power.active {
  color: var(--cyan);
  background: var(--selected);
}
.timeline {
  grid-column: 2 / 4;
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  color: var(--muted);
  font-size: 8px;
  font-variant-numeric: tabular-nums;
}
.timeline input {
  grid-column: 1 / 3;
  width: 100%;
}
.timeline span:last-child {
  justify-self: end;
}
.transport-controls {
  grid-column: 2 / 4;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 15px;
}
.transport-controls button {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  color: var(--text-soft);
  background: transparent;
  border-radius: 50%;
}
.transport-controls button:hover {
  color: var(--text);
  background: var(--control);
}
.transport-controls .primary-play {
  width: 54px;
  height: 54px;
  color: #fff;
  background: var(--cyan);
  box-shadow: 0 10px 24px color-mix(in srgb, var(--cyan) 25%, transparent);
}
.transport-controls .primary-play:active {
  transform: scale(0.94);
}
.volume-control {
  grid-column: 1 / 4;
  display: grid;
  grid-template-columns: 18px 1fr 34px;
  align-items: center;
  gap: 9px;
  color: var(--muted);
}
.volume-control strong {
  color: var(--text-soft);
  font-size: 9px;
  font-weight: 550;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.local-player input[type="range"] {
  height: 44px;
  margin: 0;
  appearance: none;
  background: transparent;
  cursor: pointer;
  touch-action: pan-y;
}
.local-player input[type="range"]::-webkit-slider-runnable-track {
  height: 8px;
  border-radius: 999px;
  background: linear-gradient(to right, var(--cyan) var(--progress), var(--line-strong) var(--progress));
}
.local-player input[type="range"]::-webkit-slider-thumb {
  width: 22px;
  height: 22px;
  margin-top: -7px;
  appearance: none;
  border-radius: 50%;
  background: var(--cyan);
  box-shadow: 0 4px 12px color-mix(in srgb, var(--cyan) 20%, transparent);
}
.local-player input[type="range"]:disabled {
  cursor: default;
  opacity: 0.45;
}
.disabled .album-art,
.disabled .track-copy,
.disabled .timeline,
.disabled .transport-controls,
.disabled .volume-control {
  opacity: 0.58;
}
.unavailable {
  cursor: not-allowed;
}
.unavailable .speaker-power,
.unavailable .transport-controls button {
  cursor: not-allowed;
  filter: saturate(0.45);
}
@media (max-height: 540px) {
  .local-player {
    grid-template-columns: 82px minmax(0, 1fr) 44px;
    grid-template-rows: 74px 27px 48px 26px;
    column-gap: 14px;
    padding: 14px 22px;
  }
  .album-art {
    width: 82px;
    height: 82px;
    border-radius: 23px;
  }
  .record {
    width: 54px;
    height: 54px;
  }
  .track-copy h1 {
    margin-block: 6px 3px;
    font-size: 18px;
  }
  .transport-controls .primary-play {
    width: 46px;
    height: 46px;
  }
}
@media (max-height: 360px) {
  .local-player {
    grid-template-columns: 1fr 44px;
    grid-template-rows: 57px 28px 48px 25px;
    padding: 11px 18px;
  }
  .album-art {
    display: none;
  }
  .timeline,
  .transport-controls {
    grid-column: 1 / 3;
  }
  .volume-control {
    grid-column: 1 / 3;
  }
  .track-copy h1 {
    font-size: 16px;
  }
}
@keyframes record-spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes music-meter {
  from {
    height: 22%;
  }
  to {
    height: 96%;
  }
}
</style>
