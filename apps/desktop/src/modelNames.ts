// How Claude Code names a model depends on how it is signed in: "Opus 5.5" with a description of its own after a
// browser login, "Opus" with "Opus 5.5 · Best for …" after a setup token. A name is shown with its version either
// way, and the description without the name it repeats.
type Named = { displayName: string; description: string };

export function modelName({ displayName, description }: Named) {
  if (/\d/.test(displayName)) return displayName;
  const lead = description.split(' · ')[0].trim();
  return /\d/.test(lead) && lead.toLowerCase().startsWith(`${displayName.toLowerCase()} `)
    ? lead
    : displayName;
}

export function modelDetail(model: Named) {
  const name = modelName(model);
  return model.description.startsWith(`${name} · `)
    ? model.description.slice(name.length + 3)
    : model.description;
}
