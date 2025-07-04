import { EditCommand } from "./EditCommand.js";
import { EditorPowersCommand } from "./EditorPowersCommand.js";
import { EndorseCommand } from "./EndorseCommand.js";
import { GetPostCommand } from "./GetPostCommand.js";
import { GetPostsByCommand } from "./GetPostsByCommand.js";
import { GetStatsCommand } from "./GetStatsCommand.js";
import { GetThanksCommand } from "./GetThanksCommand.js";
import { Mwa } from "./MwaCommand.js";
import { ToggleHelper } from "./ToggleHelper.js";
export function getCommands() {
    const Commands = [
        new Mwa(),
        new EndorseCommand(),
        new EditorPowersCommand(),
        new GetPostCommand(),
        new GetThanksCommand(),
        new GetPostsByCommand(),
        new GetStatsCommand(),
        new EditCommand(),
        new ToggleHelper()
    ];
    return Commands;
}