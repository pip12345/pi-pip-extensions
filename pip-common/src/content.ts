export function textFromContent(content: any, separator = " "): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text")
    .map((block) => block.text || "")
    .join(separator);
}

export function firstTextBlock(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const block = content.find((item) => item?.type === "text");
  return block?.type === "text" ? String(block.text ?? "") : "";
}

export function resultText(result: any, separator = " "): string {
  return textFromContent(result?.content, separator);
}

export function firstResultText(result: any): string {
  return firstTextBlock(result?.content);
}

export function setTextContent(message: any, text: string): boolean {
  if (!message) return false;
  if (typeof message.content === "string") {
    message.content = text;
    return true;
  }
  if (Array.isArray(message.content)) {
    let replaced = false;
    const next: any[] = [];
    for (const block of message.content) {
      if (block?.type === "text") {
        if (!replaced) {
          next.push({ ...block, text });
          replaced = true;
        }
      } else {
        next.push(block);
      }
    }
    if (!replaced) next.unshift({ type: "text", text });
    message.content = next;
    return true;
  }
  message.content = text;
  return true;
}

export function hasTextContent(content: any): boolean {
  return textFromContent(content).trim().length > 0;
}
