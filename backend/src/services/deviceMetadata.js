function normalizeDeviceModelName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (
    !name ||
    /^(?:موديل غير معروف|unknown(?: device)?|device|mobile tablet\/phone)$/i.test(
      name,
    ) ||
    /^(ANDROID|IOS|IPADOS|WEB)-Device-[A-Za-z0-9]{4}$/i.test(name) ||
    /^dev-[0-9a-f-]{30,}$/i.test(name) ||
    /^user-[0-9a-f-]{30,}$/i.test(name) ||
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(name)
  ) {
    return null;
  }
  return name;
}

module.exports = { normalizeDeviceModelName };
