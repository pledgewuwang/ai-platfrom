/**
 * 分级检索(Hierarchical Retrieval)共享客户端
 *
 * 对话平台与写作台共用同一份 HR 引擎接入层:
 * - retrieveMemoryBlock:召回与问题相关的历史记忆块(注入 system 上下文)
 * - ingestTurn:对话后入库,长期记忆持续积累
 * - ingestSvsgResult:SVSG 图片分析结构化结果入库
 * 实际实现在 hr-client.ts,本模块是共享层的规范出口(写作台只 import 这里)。
 */
export {
  retrieveMemoryBlock,
  ingestTurn,
  ingestSvsgResult,
  retrieve,
  healthCheck,
  chatCompletionStream,
} from "./hr-client";
