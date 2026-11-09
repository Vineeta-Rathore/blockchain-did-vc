// Command-line arguments of the Sepolia scripts: `--name value` pairs and bare `--flag` switches.
function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const flag = (name) => process.argv.includes(name);

module.exports = { arg, flag };
