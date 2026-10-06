# Regenerate with:  vhs assets/demo.tape   (from the repo root, after npm run build)
# Runs the real CLI against a throwaway LETHE_HOME and repo -- nothing is staged.

Output assets/demo.gif

Require node
Set Shell zsh
Set FontSize 18
Set Width 1400
Set Height 460
Set Padding 28
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms
Set WindowBar Colorful

Hide
Type "export ROOT=$PWD LETHE_HOME=$(mktemp -d) LETHE_TELEMETRY=0 NODE_NO_WARNINGS=1 PS1='%F{cyan}analytics%f $ '" Enter
Type `lethe(){ node $ROOT/dist/cli.js "$@"; }; setopt interactivecomments` Enter
Type "cd $(mktemp -d) && git init -q analytics && cd analytics && lethe init --private >/dev/null </dev/null && clear" Enter
Show

Type "# Tuesday: an hour lost on counts that don't add up. The agent notes why" Enter
Sleep 600ms
Type "lethe note 'Events land on the wrong day: timestamps are UTC' 'convert to local time before grouping'" Enter
Sleep 1.8s

Type "# Thursday: fresh session, no context. Ask about it:" Enter
Sleep 600ms
Type "lethe recall 'why are some events counted on the wrong day'" Enter
Sleep 3.5s

Type "# Memory is markdown on disk, and private unless you choose to share it" Enter
Sleep 600ms
Type "lethe ls" Enter
Sleep 2s
Type "git status --short -uall" Enter
Sleep 3.5s
