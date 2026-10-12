/**
 * DiskWideScope —— **哪些能力按"本机文件域"判定**（而不是按动作沙箱）。
 *
 * ============================================================================
 *  用户 2026-10-05 裁定（`L-RTD-18`）
 * ============================================================================
 * 原话：**「L-RTD-18 允许访问本机所有文件」**。
 *
 * ```text
 * 裁定前：只有 `local.file.*` 三件按"已授权的本机文件域"判定；`document.read` 与
 *        `image.ocr` 的目标**仍按沙箱判**，而装配层在 `localFileRead` 打开时又给它们
 *        注入"本机全域跨域入口" ⇒ 目标被解析成 `local-disk` 却按沙箱拒
 *        ⇒ 如实报 `permission_denied`（"目标在沙箱范围之外"）。
 *        实测形态：`postlv2:role-tool:matrix` 的 A12「生成 Office 后读回」——
 *        生成那一半成功、读回那一半被拒。
 * 裁定后：文档与图片读取**与 `local.file.*` 同一套域判定**（本机全域）。
 * ```
 *
 * ============================================================================
 *  这条扩大**是什么**、**不是什么**（必须分开读）
 * ============================================================================
 * ```text
 * 是  ：域判定与策略措辞从"沙箱"改成"已授权的本机文件域"—— 于是任意绝对路径的
 *       文档/图片都能被读（仍然要过各自的能力开关、权限、目标解析与风险等级）。
 * 不是：不新增能力、不新增动作种类、不改风险等级、不放宽"网络共享 / 设备路径 /
 *       备用数据流一律拒"的路径闸（那条在 `local-path.ts` 的 `inspectLocalPath` 里），
 *       也不让任何**写**动作获得新的域（写入仍只有 `local.file.write` / `office.generate`
 *        / 沙箱写三件，各自域不变）。
 * ```
 *
 * ⚠️ 本文件**只**回答"这个能力该按哪个域判定"这一个问题：不读环境、不读开关、
 *    不做权限判定（那三件事分别在装配层、Policy 与 Gateway）。
 */

import {
  LOCAL_FILE_LIST,
  LOCAL_FILE_READ,
  LOCAL_FILE_WRITE,
} from './local-file-capabilities.ts'
import { DOCUMENT_READ, IMAGE_OCR } from './utility-capabilities.ts'

/**
 * 按**本机文件域**判定的能力全集。
 *
 * ⚠️ 顺序 = 既有顺序（三件本机文件 → 两件文档/图片），加一个要在这里加、并同时改
 *    `main.ts` 与验收入口的域判定分支 + 加一条用例。
 */
export const DISK_WIDE_CAPABILITY_IDS: readonly string[] = [
  LOCAL_FILE_LIST,
  LOCAL_FILE_READ,
  LOCAL_FILE_WRITE,
  DOCUMENT_READ,
  IMAGE_OCR,
]

export function isDiskWideCapability(capabilityId: string): boolean {
  return DISK_WIDE_CAPABILITY_IDS.includes(capabilityId)
}
