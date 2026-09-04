/**
 * 多模态视觉适配层
 * 处理不同模型的图片/视频格式差异
 */

export type MediaType = "image" | "video";

export interface MediaAttachment {
  type: MediaType;
  mimeType: string;     // image/png, video/mp4, etc.
  data: string;         // base64 data (without prefix) 或 URL
  isUrl?: boolean;      // data 是否为 URL
  filename?: string;
}

/**
 * 模型视觉能力配置
 */
const MODEL_VISION_CONFIG: Record<string, {
  supportsVision: boolean;
  supportsVideo: boolean;
  format: "openai" | "anthropic" | "google";
}> = {
  // OpenAI 系列
  "openai/gpt-4o":         { supportsVision: true, supportsVideo: false, format: "openai" },
  "openai/gpt-4o-mini":    { supportsVision: true, supportsVideo: false, format: "openai" },
  "openai/gpt-4.1":        { supportsVision: true, supportsVideo: false, format: "openai" },
  "openai/gpt-4.1-mini":   { supportsVision: true, supportsVideo: false, format: "openai" },
  "openai/gpt-image":      { supportsVision: false, supportsVideo: false, format: "openai" },

  // Claude 系列（需要 Anthropic 格式）
  "claude-opus-5":         { supportsVision: true, supportsVideo: false, format: "anthropic" },
  "claude-sonnet-4":       { supportsVision: true, supportsVideo: false, format: "anthropic" },
  "claude-haiku-3.5":      { supportsVision: true, supportsVideo: false, format: "anthropic" },

  // Gemini
  "gemini-2.5-pro":        { supportsVision: true, supportsVideo: true, format: "google" },
  "gemini-2.5-flash":      { supportsVision: true, supportsVideo: true, format: "google" },

  // DeepSeek（无视觉）
  "deepseek-chat":         { supportsVision: false, supportsVideo: false, format: "openai" },
  "deepseek-reasoner":     { supportsVision: false, supportsVideo: false, format: "openai" },
  "deepseek-v4-pro":       { supportsVision: false, supportsVideo: false, format: "openai" },
  "deepseek-v4-flash":     { supportsVision: false, supportsVideo: false, format: "openai" },

  // GLM（无视觉）
  "glm-4.6":               { supportsVision: false, supportsVideo: false, format: "openai" },
  "glm-5.3":               { supportsVision: false, supportsVideo: false, format: "openai" },

  // MIMO（无视觉）
  "mimo-v2.5-pro":         { supportsVision: false, supportsVideo: false, format: "openai" },
  "mimo-v2.5":             { supportsVision: false, supportsVideo: false, format: "openai" },

  // 本地模型（默认无视觉）
  "ollama/*":              { supportsVision: false, supportsVideo: false, format: "openai" },
};

/**
 * 获取模型视觉配置
 */
export function getModelVisionConfig(modelId: string) {
  // 精确匹配
  if (MODEL_VISION_CONFIG[modelId]) {
    return MODEL_VISION_CONFIG[modelId];
  }

  // 前缀匹配（如 ollama/qwen2.5:7b）
  const prefix = modelId.split("/")[0] + "/*";
  if (MODEL_VISION_CONFIG[prefix]) {
    return MODEL_VISION_CONFIG[prefix];
  }

  // 默认：假设不支持视觉
  return { supportsVision: false, supportsVideo: false, format: "openai" as const };
}

/**
 * 将附件转换为指定模型的格式
 * 返回符合目标模型 API 的 content 数组
 */
export function formatMediaForModel(
  attachments: MediaAttachment[],
  modelId: string
): Array<{ type: string; [key: string]: unknown }> {
  const config = getModelVisionConfig(modelId);

  // 模型不支持视觉，返回空（调用方需降级处理）
  if (!config.supportsVision) {
    return [];
  }

  switch (config.format) {
    case "openai":
      return attachments.map((att) => formatForOpenAI(att));
    case "anthropic":
      return attachments.map((att) => formatForAnthropic(att));
    case "google":
      return attachments.map((att) => formatForGoogle(att));
    default:
      return attachments.map((att) => formatForOpenAI(att));
  }
}

/**
 * OpenAI 格式
 */
function formatForOpenAI(att: MediaAttachment) {
  if (att.isUrl) {
    return {
      type: "image_url",
      image_url: { url: att.data },
    };
  }
  return {
    type: "image_url",
    image_url: {
      url: `data:${att.mimeType};base64,${att.data}`,
    },
  };
}

/**
 * Anthropic 格式（Claude 专用）
 */
function formatForAnthropic(att: MediaAttachment) {
  if (att.isUrl) {
    return {
      type: "image",
      source: {
        type: "url",
        url: att.data,
      },
    };
  }
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: att.mimeType,
      data: att.data,
    },
  };
}

/**
 * Google 格式（Gemini）
 */
function formatForGoogle(att: MediaAttachment) {
  if (att.isUrl) {
    return {
      type: "file_data",
      fileData: {
        mimeType: att.mimeType,
        fileUri: att.data,
      },
    };
  }
  return {
    type: "inline_data",
    inlineData: {
      mimeType: att.mimeType,
      data: att.data,
    },
  };
}

/**
 * 构建包含媒体的完整消息
 * 处理降级逻辑：不支持视觉的模型自动提取文字描述
 */
export function buildVisionMessage(
  text: string,
  attachments: MediaAttachment[],
  modelId: string
): { role: string; content: string | Array<{ type: string; [key: string]: unknown }> } {
  const config = getModelVisionConfig(modelId);

  // 无附件，纯文本
  if (attachments.length === 0) {
    return { role: "user", content: text };
  }

  // 模型支持视觉
  if (config.supportsVision) {
    const mediaParts = formatMediaForModel(attachments, modelId);
    return {
      role: "user",
      content: [
        ...mediaParts,
        { type: "text", text: text || "请分析这张图片。" },
      ],
    };
  }

  // 模型不支持视觉 → 降级：提取文字描述
  const imageDescriptions = attachments
    .filter((a) => a.type === "image")
    .map((_, i) => `[图片 ${i + 1}]`);

  const videoDescriptions = attachments
    .filter((a) => a.type === "video")
    .map((_, i) => `[视频 ${i + 1}]`);

  const descriptions = [...imageDescriptions, ...videoDescriptions].join(", ");

  return {
    role: "user",
    content: `${text}\n\n${descriptions ? `（用户还发送了 ${descriptions}，但当前模型不支持视觉，请根据文字内容回答）` : ""}`,
  };
}

/**
 * 检查附件类型是否被模型支持
 */
export function checkAttachmentSupport(
  attachments: MediaAttachment[],
  modelId: string
): { supported: boolean; warning?: string } {
  const config = getModelVisionConfig(modelId);

  if (!config.supportsVision && attachments.length > 0) {
    return {
      supported: false,
      warning: `当前模型 ${modelId} 不支持图片/视频理解，内容将以文字降级处理。建议切换到 GPT-4o 或 Claude 模型。`,
    };
  }

  const videos = attachments.filter((a) => a.type === "video");
  if (videos.length > 0 && !config.supportsVideo) {
    return {
      supported: true,
      warning: `当前模型可能不完全支持视频理解，建议切换到 Gemini 模型。`,
    };
  }

  return { supported: true };
}
