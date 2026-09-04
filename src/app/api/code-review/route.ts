import { NextRequest } from "next/server";
import { cloudChat } from "@/lib/cloud-chat";

/**
 * 编程结果审核:用独立 API key 的模型对一段代码做审核。
 * 手动触发(前端在编程回复后提供「审核」按钮),非流式返回审核意见。
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { code, apiUrl, apiKey, model, language } = body as {
      code: string;
      apiUrl?: string;
      apiKey?: string;
      model?: string;
      language?: string;
    };

    if (!code || !code.trim()) {
      return Response.json({ error: "code is required" }, { status: 400 });
    }
    if (!apiUrl || !apiKey || !model) {
      return Response.json(
        { error: "审核需要配置 API 地址 / Key / 模型(在设置 → 审核模式中配置)" },
        { status: 400 }
      );
    }

    const langHint = language && language !== "auto" ? " 目标语言: " + language + "。" : "";
    const fence = "```";
    const reviewPrompt = "请作为资深代码审核员审核下面这段代码(可能包含多个文件)。\n" + langHint +
      "\n按以下结构输出(用与用户相同的语言):\n" +
      "1) 发现的问题(按严重程度编号,包含 bug、安全隐患、性能问题)\n" +
      "2) 改进建议(具体可操作)\n" +
      "若代码无明显问题,简要说明即可。请控制在 400 字以内,不要复述代码。\n\n" + fence + "\n" +
      code.slice(0, 20000) + "\n" + fence;

    const content = await cloudChat(
      [
        {
          role: "system",
          content: "You are a meticulous senior code reviewer. Be concise, specific, and actionable.",
        },
        { role: "user", content: reviewPrompt },
      ],
      apiUrl,
      apiKey,
      model,
      1200,
      0.3
    );

    return Response.json({ review: content || "（审核模型未返回内容）" });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "审核失败";
    console.error("[Code Review] Error:", message);
    return Response.json({ error: message.slice(0, 200) }, { status: 500 });
  }
}
