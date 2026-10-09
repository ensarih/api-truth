/** Conservative exclusion patterns, not a guarantee that arbitrary prose contains no secrets. */
export const isSemanticDocumentTextSafe = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= maximum
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  && !/-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|secret|password|token|authorization)\s*[:=]\s*\S+|https?:\/\/[^\s/]+@|\bBearer\s+\S+|\b(?:sk_live_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/i.test(value);
