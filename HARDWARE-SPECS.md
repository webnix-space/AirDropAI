# Hardware Specifications — AirDrop AI Mesh Node

## Primary Demo Device

| Spec | Value |
|------|-------|
| **Device Model** | [FILL: e.g., Samsung Galaxy S24] |
| **Operating System** | [FILL: e.g., Android 14] |
| **OS Version** | [FILL: e.g., One UI 6.1] |
| **CPU** | [FILL: e.g., Snapdragon 8 Gen 3] |
| **GPU** | [FILL: e.g., Adreno 750] |
| **GPU API** | [FILL: e.g., Vulkan 1.3] |
| **RAM** | [FILL: e.g., 8 GB] |
| **Storage (Free)** | [FILL: e.g., 128 GB total, 45 GB free] |
| **Architecture** | [FILL: e.g., arm64] |
| **Screen Resolution** | [FILL: e.g., 2340 x 1080] |
| **Battery Health** | [FILL: e.g., 95%] |

## Verification

### GPU Support Check
- [ ] Android: Vulkan Caps Viewer app shows Vulkan 1.1+ supported
- [ ] iOS: Metal supported (all iOS 17+ devices)

### QVAC Model Cache
- [ ] LLM model cached: `~/.cache/qvac/models/` or app storage
- [ ] Embedding model cached: `~/.cache/qvac/models/`
- [ ] Total cache size: ~2.0 GB

## Performance Benchmarks (Run on Your Device)

Run the app on your physical device, perform the standard demo, then tap **"Export Audit Log"** in the app. Fill in the values from the exported JSON:

| Metric | Your Value | Screenshot |
|--------|-----------|------------|
| LLM Load Time | ___ ms | [attach] |
| Embedder Load Time | ___ ms | [attach] |
| TTFT (Time To First Token) | ___ ms | [attach] |
| Tokens/Second | ___ tok/s | [attach] |
| RAG Index (1KB text) | ___ ms | [attach] |
| RAG Search (top-3) | ___ ms | [attach] |
| Memory Usage (Peak) | ___ MB | [attach] |
| CPU Usage (Peak) | ___ % | [attach] |
| GPU Usage (Peak) | ___ % | [attach] |

## System Profiler Screenshots

Attach screenshots from:
- [ ] Android Studio Profiler (CPU, Memory, GPU graphs during inference)
- [ ] Xcode Instruments (Time Profiler, GPU Driver)
- [ ] Or device built-in profiler (Developer Options → GPU Rendering Profile)

## Notes

[Any special setup, modifications, or observations about this device]
