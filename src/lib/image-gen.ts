/**
 * 图片生成客户端
 * 支持多个 provider：flux, dall-e, tongyi
 */

export type ImageProvider = "flux" | "dall-e" | "gpt-image" | "gpt-image-2" | "tongyi";

export interface ImageGenResult {
  url: string;
  revisedPrompt?: string;
  provider: ImageProvider;
}

/**
 * 生成图片 - 调用对应 provider 的 API
 */
export async function generateImage(
  prompt: string,
  apiKey: string,
  apiProvider: ImageProvider = "flux"
): Promise<ImageGenResult> {
  switch (apiProvider) {
    case "flux":
      return generateWithFlux(prompt, apiKey);
    case "dall-e":
      return generateWithDallE(prompt, apiKey);
    case "gpt-image":
    case "gpt-image-2":
      return generateWithGptImage(prompt, apiKey);
    case "tongyi":
      return generateWithTongyi(prompt, apiKey);
    default:
      throw new Error(`Unsupported provider: ${apiProvider}`);
  }
}

/**
 * Flux API 图片生成
 */
async function generateWithFlux(
  prompt: string,
  apiKey: string
): Promise<ImageGenResult> {
  const response = await fetch("https://api.bfl.ml/v1/flux-pro-1.1", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Key": apiKey,
    },
    body: JSON.stringify({
      prompt,
      width: 1024,
      height: 1024,
      steps: 28,
      guidance: 3.5,
    }),
  });

  if (!response.ok) {
    await response.text().catch(() => null); // 读完释放连接,不回显上游错误内容
    throw new Error(`Flux API error: ${response.status}`);
  }

  const data = await response.json();

  // Flux returns a task ID, need to poll for result
  if (data.id) {
    const result = await pollFluxResult(data.id, apiKey);
    return { url: result, provider: "flux" };
  }

  // Direct URL response
  if (data.images?.[0]?.url) {
    return { url: data.images[0].url, provider: "flux" };
  }

  throw new Error("Flux: No image URL in response");
}

async function pollFluxResult(
  taskId: string,
  apiKey: string,
  maxAttempts = 60,
  intervalMs = 2000
): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));

    const response = await fetch(
      `https://api.bfl.ml/v1/get_result?id=${taskId}`,
      {
        headers: { "X-Key": apiKey },
      }
    );

    if (!response.ok) continue;

    const data = await response.json();

    if (data.status === "Ready" && data.result?.sample) {
      return data.result.sample;
    }

    if (data.status === "Error") {
      throw new Error(`Flux generation failed: ${JSON.stringify(data)}`);
    }
  }

  throw new Error("Flux: Generation timed out");
}

/**
 * DALL-E API 图片生成
 */
async function generateWithDallE(
  prompt: string,
  apiKey: string
): Promise<ImageGenResult> {
  const response = await fetch(
    "https://api.openai.com/v1/images/generations",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "dall-e-3",
        prompt,
        n: 1,
        size: "1024x1024",
        quality: "standard",
      }),
    }
  );

  if (!response.ok) {
    await response.text().catch(() => null); // 读完释放连接,不回显上游错误内容
    throw new Error(`DALL-E API error: ${response.status}`);
  }

  const data = await response.json();
  const image = data.data?.[0];

  if (!image?.url) {
    throw new Error("DALL-E: No image URL in response");
  }

  return {
    url: image.url,
    revisedPrompt: image.revised_prompt,
    provider: "dall-e",
  };
}

/**
 * GPT Image 2（七牛云中转）图片生成
 * 异步任务模式：提交任务 → 轮询状态 → 获取结果
 */
async function generateWithGptImage(
  prompt: string,
  apiKey: string
): Promise<ImageGenResult> {
  const response = await fetch(
    "https://api.qnaigc.com/v1/images/generations",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "openai/gpt-image-2",
        prompt,
        n: 1,
        size: "1024x1024",
      }),
    }
  );

  if (!response.ok) {
    await response.text().catch(() => null); // 读完释放连接,不回显上游错误内容
    throw new Error(`GPT Image 2 error: ${response.status}`);
  }

  const data = await response.json();
  const image = data.data?.[0];

  if (image?.b64_json) {
    return {
      url: `data:image/png;base64,${image.b64_json}`,
      revisedPrompt: image.revised_prompt,
      provider: "gpt-image",
    };
  }

  if (image?.url) {
    return {
      url: image.url,
      revisedPrompt: image.revised_prompt,
      provider: "gpt-image",
    };
  }

  throw new Error("GPT Image 2: No image in response");
}

/**
 * 通义万相 (Tongyi Wanxiang) 图片生成
 */
async function generateWithTongyi(
  prompt: string,
  apiKey: string
): Promise<ImageGenResult> {
  // 通义万相使用 DashScope API
  const response = await fetch(
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-DashScope-Async": "enable",
      },
      body: JSON.stringify({
        model: "wanx-v1",
        input: { prompt },
        parameters: {
          n: 1,
          size: "1024*1024",
          style: "<auto>",
        },
      }),
    }
  );

  if (!response.ok) {
    await response.text().catch(() => null); // 读完释放连接,不回显上游错误内容
    throw new Error(`Tongyi API error: ${response.status}`);
  }

  const data = await response.json();
  const taskId = data.output?.task_id;

  if (!taskId) {
    // Synchronous response
    const imageUrl = data.output?.results?.[0]?.url;
    if (imageUrl) {
      return { url: imageUrl, provider: "tongyi" };
    }
    throw new Error("Tongyi: No image URL in response");
  }

  // Poll async result
  return await pollTongyiResult(taskId, apiKey);
}

async function pollTongyiResult(
  taskId: string,
  apiKey: string,
  maxAttempts = 60,
  intervalMs = 3000
): Promise<ImageGenResult> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));

    const response = await fetch(
      `https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    if (!response.ok) continue;

    const data = await response.json();

    if (data.output?.task_status === "SUCCEEDED") {
      const imageUrl = data.output.results?.[0]?.url;
      if (imageUrl) {
        return { url: imageUrl, provider: "tongyi" };
      }
    }

    if (data.output?.task_status === "FAILED") {
      throw new Error(`Tongyi generation failed: ${data.output.message}`);
    }
  }

  throw new Error("Tongyi: Generation timed out");
}
