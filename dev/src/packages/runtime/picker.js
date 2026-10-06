// [runtime/picker] 原生目录选择器：直接调用 DSH 自己的 directoryPicker（native 能力）
// 旧版自跑的 powershell + WinForms FolderBrowserDialog 已删除 —— 那是 DSH 之外的第二套壳弹窗；
// 现在让 DSH 在宿主屏幕上打开它自己的现代 OS 选择器。调用形状对齐官方 apiproxy：
// capability().kind === 'native' → capability().pick(signal)（Windows 上是 IFileOpenDialog）。
async function pickDirNative(cap) {
  if (cap === undefined || cap.kind !== 'native' || typeof cap.pick !== 'function') {
    throw new Error('原生目录选择不可用（当前 directoryPicker 后端: ' + String(cap && cap.kind) + '）')
  }
  try {
    // DSH 的 pick(signal) 不接受起始目录（由 OS 按上次位置打开）；用户取消时返回 null。
    return await cap.pick(new AbortController().signal)
  } catch (error) {
    throw new Error('原生目录选择失败: ' + safeErrorMsg(error))
  }
}
