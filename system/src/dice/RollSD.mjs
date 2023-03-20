export default class RollSD extends Roll {

	/**
	 * Main roll method for rolling. It checks if the roll is a
	 * d20, and if true, checks for special cases.
	 *
	 * The `data` object generally just needs an `actor` or and `item` as key:values.
	 *
	 * The `options` object configures the rolls, and chat messages. The following optional keys
	 * may be used:
	 * - fastForward {boolean}: Skips dialogs and just rolls normal rolls if set to true
	 * - rollMode {string}: If the self/gm/blind/public roll mode is to be predetermined
	 * - flavor {string}: Flavor text on the chat card (smaller text under actor name)
	 * - title {string}: Title of the chat card, set next to the icon
	 * - target {number}: If the roll has a target to meet or beat
	 * - dialogTemplate {handlebars}: Handlebars template to base Dialog on
	 * - dialogTitle {string}: The title of the rendered dialog
	 * - dialogOptions {object}: Options to be sent to the Dialog renderer
	 * - chatCardTemplate {handlebars}: Handlebars template to base Chatcard on
	 * - speaker {object}: Speaker as generated by `ChatMessage.getSpeaker()`
	 * - chatMessage {boolean}: Set to false if no chat message should be generated
	 *
	 * @param {Array<string>}		- Parts for the roll
	 * @param {object} data 		- Data that carries actor and/or item
	 * @param {jQuery} $form 		- Form from an evaluated dialog
	 * @param {number} adv			- Determine the direction of advantage (1)
	 * / disadvantage (-1)
	 * @param {object} options	- Options to modify behavior
	 * @returns {Promise<object>}
	 */
	static async Roll(parts, data, $form, adv=0, options={}) {
		// If the dice has been fastForwarded, there is no form
		if (!options.fastForward) {
			// Augment data with form bonuses & merge into data
			const formBonuses = this._getBonusesFromFrom($form);
			data = foundry.utils.mergeObject(data, formBonuses);
		}

		options.rollMode = $form ? this._getRollModeFromForm($form) : game.settings.get("core", "rollMode");

		// Roll the Dice
		data.rolls = {
			main: await this._rollAdvantage(parts, data, adv),
		};

		// Special cases for D20 rolls
		if (this._isD20(parts)) {
			// Weapon? -> Roll Damage dice
			if (data.item?.isWeapon()) {
				data = await this._rollWeapon(data);
				if (!options.flavor) {
					options.flavor = game.i18n.format(
						"SHADOWDARK.chat.item_roll.title",
						{
							name: data.item.name,
						}
					);
				}
			}

			// Spell? -> Set a target
			if (data.item?.isSpell()) {
				options.target = data.item.system.tier + 10;
				if (!options.flavor) {
					options.flavor = game.i18n.format(
						"SHADOWDARK.chat.spell_roll.title",
						{
							name: data.item.name,
							tier: data.item.system.tier,
							spellDC: options.target,
						}
					);
				}
			}
		}

		// Build the Chat Data
		return this._renderRoll(data, adv, options);
	}

	/**
	 * Helper method to lazily roll a D20.
	 * @param {Array<string>}	- Parts for the roll
	 * @param {object} data 	- Data that carries actor and/or item
	 * @param {jQuery} $form 	- Form from an evaluated dialog
	 * @param {number} adv		- Determine the direction of advantage (1)
	 * 																/ disadvantage (-1)
	 * @param {*} options 		- Options to modify behavior
	 */
	static async RollD20(parts, data, $form, adv=0, options={}) {
		if ( parts[0] !== "1d20") parts.unshift("1d20");
		return this.Roll(parts, data, $form, adv, options);
	}

	/* -------------------------------------------- */
	/*  Roll Analysis                               */
	/* -------------------------------------------- */

	/**
	 * Checks if the roll is a D20 roll.
	 * @param {Array<string>} parts - Roll parts, starting with main dice
	 * @returns {boolean}
	 */
	static _isD20(parts) {
		if (typeof parts[0] !== "string") return false;
		if (parts[0] && parts[0].split("d")) return (parseInt(parts[0].split("d")[1], 10) === 20);
		return false;
	}

	/**
	 * Checks if a d20 has been rolled with either a result of
	 * 1 (failure) or 20 (success) and returns that as a string.
	 *
	 * Options:
	 * - critical.failureThreshold: Modified lower threshold for critical failure
	 * - critical.successThreshold: Modified higher threshold for critical success
	 *
	 * @param {Roll} roll 			- Roll results
	 * @param {object} options	- Options for the critical check
	 * @returns {string|null} 	- Analysis result
	 */
	static _digestCritical(roll, options={}) {
		if ( roll.terms[0].faces !== 20 ) return null;

		// Check if different threshold are given as options
		const failureThreshold = (options.critical?.failureThreshold)
			? options.critical.failureThreshold : 1;

		const successThreshold = (options.critical?.successThreshold)
			? options.critical.successThreshold : 20;

		// Get the final result if using adv/disadv
		if ( roll.terms[0].total >= successThreshold ) return "success";
		else if ( roll.terms[0].total <= failureThreshold ) return "failure";
		return null;
	}

	/**
	 * Removes the `@bonus` valeus from `parts` array that do not have
	 * corresponding `data.bonus` value, for a cleaner roll.
	 * @param {Array<string>} parts - Parts with bonuses to add to roll, starting with at
	 * @param {object} data 				- Data object containing `data.bonusX` values
	 * @returns {Array<string>}			- Parts with only defined bonuses in data object
	 */
	static _digestParts(parts, data) {
		const reducedParts = [];
		parts.forEach(part => {
			// If both the bonus is defined, and not 0, push to the results
			if (
				data[part.substring(1)] && parseInt(data[part.substring(1)], 10) !== 0
			) reducedParts.push(part);
		});
		return reducedParts;
	}

	/**
	 * Modifies the first term in `rollParts` to roll with either advantage
	 * or disadvantage. Does nothing if multiple dice are first parts.
	 * @param {Array<string>} rollParts	- Array containing parts for rolling
	 * @param {-1|0|1} adv 							- Pre-determined Advantage
	 * @returns {Array<string>}					- Modified rollParts
	 */
	static _partsAdvantage(rollParts,	adv=0) {
		const splitDice = rollParts[0].split("d");
		if (parseInt(splitDice[0], 10) !== 1) return rollParts;

		if (adv === 1) {
			rollParts[0] = `${splitDice[0] * 2}d${splitDice[1]}kh`;
		}
		else if (adv === -1) {
			rollParts[0] = `${splitDice[0] * 2}d${splitDice[1]}kl`;
		}
		return rollParts;
	}

	/* -------------------------------------------- */
	/*  Dice Rolling                                */
	/* -------------------------------------------- */

	/**
	 * Rolls dice, with parts. Evaluates them, and returns the data.
	 * @param {Array<string>}	parts	- Dice and Bonuses associated with the roll `@bonus`
	 * @param {object} data					- Data for the roll, incl. values for bonuses, like
	 * `data.bonus`
	 * @returns {object} 						- Returns the evaluated `roll`, the rendered
	 * HTML `renderedHTML`, and `critical` info.
	 */
	static async _roll(parts, data={}) {
		// Check the numDice has been given, otherwise add 1 dice
		if (parts[0][0] === "d") parts[0] = `1${parts[0]}`;

		// Save the first entry, assuming this is the main dice
		const mainDice = parts[0];

		parts = this._digestParts(parts, data);

		// Put back the main dice
		parts.unshift(mainDice);

		const roll = await new Roll(parts.join(" + "), data).evaluate({async: true});
		const renderedHTML = await roll.render();

		// Also send the actors critical bonuses in case it has modified thresholds
		const critical = this._digestCritical(roll, data.actor?.system?.bonuses);

		return {
			roll,
			renderedHTML,
			critical,
		};
	}

	/**
	 * Modifies the first dice to roll it with advantage (2dXkh) or
	 * disadvantage (2dXkl).
 	 * @param {Array<string>} parts - Main Dice, and bonus parts (`@bonus`)
	 * @param {object} data 				- Data carrying object for use in roll.
	 * @param {-1|0|1} adv 					- Determine the direction of advantage (1)
	 * / disadvantage (-1) or normal (0).
	 * @returns {object}						- Object containing evaluated roll data
	 */
	static async _rollAdvantage(parts, data={}, adv=0) {
		parts = this._partsAdvantage(parts, adv);
		return this._roll(parts, data);
	}

	/**
	 * Analyses provided `data` and rolls with supplied bonuses, and advantage if
	 * requested.
	 * @param {Array<string>} parts - Bonus parts (@bonus) for consideration in roll
	 * @param {object} data 				- Data carrying object for use in roll.
	 * @param {-1|0|1} adv 					- Determine the direction of advantage (1)
	 * 																/ disadvantage (-1)
	 * @returns {object}						- Object containing evaluated roll data
	 */
	static async _rollD20(parts = [], data={}, adv=0) {
		// Modify the d20 to take advantage in consideration
		if ( parts[0] !== "1d20") parts.unshift("1d20");
		return this._rollAdvantage(parts, data, adv);
	}

	/* -------------------------------------------- */
	/*  Special Case Rolling                        */
	/* -------------------------------------------- */

	/**
	 * Rolls a weapon when suppled in the `data` object.
	 * @param {object} data - Object containing the item document of rolled item
	 * @returns {object}		- Returns the data object, with additional roll evaluations
	 */
	static async _rollWeapon(data) {
		// Get dice information from the weapon
		let numDice = data.item.system.damage.numDice;
		const damageDie = data.item.isTwoHanded()
			?	data.item.system.damage.twoHanded : data.item.system.damage.oneHanded;

		// Check and handle critical failure/success
		if ( data.rolls.main.critical !== "failure" ) {
			let primaryParts = [];

			// Adds dice if backstabbing
			if (data.backstab) {
				// Additional dice
				numDice += 1;
				if (data.actor.system.bonuses.backstabDie) numDice +=
					parseInt(data.actor.system.bonuses.backstabDie, 10)
					+ Math.floor(data.actor.system.level.value / 2);
			}

			// Multiply the dice with the items critical multiplier
			if ( data.rolls.main.critical === "success" ) numDice *= data.item.system.damage.critMultiplier;

			primaryParts = [`${numDice}${damageDie}`, ...data.damageParts];

			data.rolls.primaryDamage = await this._roll(primaryParts, data);

			if ( data.item.isVersatile() ) {
				const secondaryParts = [
					`${numDice}${data.item.system.damage.twoHanded}`,
					...data.damageParts];
				data.rolls.secondaryDamage = await this._roll(secondaryParts, data);
			}
		}
		return data;
	}

	/* -------------------------------------------- */
	/*  Dialog & Form Digestion                     */
	/* -------------------------------------------- */

	/**
	 * Extract the roll mode from a form
	 * @param {jQuery} $form 	- Callback HTML from dialog
	 * @returns {string}			- Selected Rollmode
	 */
	static _getRollModeFromForm($form) {
		return $form.find("[name=rollMode]").val();
	}

	/**
	 * Parses a submitted dialog form for bonuses
	 * @param {jQuery} $form 	- Submitted dialog form
	 * @returns {object}			- Bonuses from the dialog form
	 */
	static _getBonusesFromFrom($form) {
		const bonuses = {};
		if ($form.find("[name=item-bonus]").length) bonuses.itemBonus = $form.find("[name=item-bonus]")?.val();
		if ($form.find("[name=ability-bonus]").length) bonuses.abilityBonus = $form.find("[name=ability-bonus]")?.val();
		if ($form.find("[name=talent-bonus]").length) bonuses.talentBonus = $form.find("[name=talent-bonus]")?.val();
		if ($form.find("[name=weapon-backstab]").length) bonuses.backstab = $form.find("[name=weapon-backstab]")?.prop("checked");
		return bonuses;
	}

	/* -------------------------------------------- */
	/*  Dialogs                                     */
	/* -------------------------------------------- */

	/**
	 * Renders HTML for display as roll dialog
	 * @param {Array<string>} parts		- Dice formula parts
	 * @param {object} data 					- Data for use in the dialog
	 * @param {object} options 				- Configuration options for dialog
	 * @returns {jQuery}							- Rendered HTML object
	 */
	static async _getRollDialogContent(
		parts,
		data,
		options = {}
	) {
		const dialogTemplate = options.dialogTemplate
			? options.dialogTemplate
			: "systems/shadowdark/templates/dialog/roll-dialog.hbs";

		const dialogData = {
			data,
			rollMode: game.settings.get("core", "rollMode"),
			formula: Array.from(parts).join(" + "),
			rollModes: CONFIG.Dice.rollModes,
		};

		return renderTemplate(dialogTemplate, dialogData);
	}

	/**
	 * Renders a Roll Dialog and displays the appropriate bonuses
	 * @param {Array<string>} parts - Predetermined roll @bonuses
	 * @param {object} data 				- Data container with dialogTitle
	 * @param {object} options 			- Configuration options for dialog
	 * @returns {object}						- Returns final data structure
	 */
	static async RollD20Dialog(parts, data, options={}) {
		// Render the HTML for the dialog
		const content = await this._getRollDialogContent(parts, data, options);

		if ( options.fastForward ) {
			return await this.RollD20(parts, data, false, 0, options);
		}

		return await new Promise(resolve => {
			let roll;
			new Dialog(
				{
					title: options.dialogTitle
						? options.dialogTitle : game.i18n.localize("SHADOWDARK.roll.D20"),
					content,
					buttons: {
						advantage: {
							label: game.i18n.localize("SHADOWDARK.roll.advantage"),
							callback: async html => {
								resolve(this.RollD20(parts, data, html, 1, options));
							},
						},
						normal: {
							label: game.i18n.localize("SHADOWDARK.roll.normal"),
							callback: async html => {
								resolve(this.RollD20(parts, data, html, 0, options));
							},
						},
						disadvantage: {
							label: game.i18n.localize("SHADOWDARK.roll.disadvantage"),
							callback: async html => {
								resolve(this.RollD20(parts, data, html, -11, options));
							},
						},
					},
					default: "normal",
					close: () => {
						resolve(roll);
					},
					render: () => {
						// Check if the actor has advantage, and add highlight if that is the case
						if (data.actor?.hasAdvantage(data))	$("button.advantage")
							.attr("title", game.i18n.localize("SHADOWDARK.dialog.tooltip.talent_advantage"))
							.addClass("talent-highlight");
					},
				},
				options.dialogOptions
			).render(true);
		});
	}

	// @todo: Refactor this to not have RollDialog and RollD20Dialog being so similar
	/**
	 * Renders a Roll Dialog and displays the appropriate bonuses
	 * @param {Array<string>} parts - Predetermined roll dice & @bonuses
	 * @param {object} data 				- Data container with dialogTitle
	 * @param {object} options 			- Configuration options for dialog
	 * @returns {Promise(Roll)}			- Returns the promise of evaluated roll(s)
	 */
	static async RollDialog(parts, data, options={}) {
		// Render the HTML for the dialog
		let content;
		content = await this._getRollDialogContent(parts, data, options);

		if ( options.fastForward ) {
			return await this.Roll(parts, data, false, 0, options);
		}

		return new Promise(resolve => {
			let roll;
			new Dialog(
				{
					title: options.dialogTitle
						? options.dialogTitle : game.i18n.localize("SHADOWDARK.roll.D20"),
					content,
					buttons: {
						advantage: {
							label: game.i18n.localize("SHADOWDARK.roll.advantage"),
							callback: async html => {
								roll = await this.Roll(parts, data, html, 1, options);
							},
						},
						normal: {
							label: game.i18n.localize("SHADOWDARK.roll.normal"),
							callback: async html => {
								roll = await this.Roll(parts, data, html, 0, options);
							},
						},
						disadvantage: {
							label: game.i18n.localize("SHADOWDARK.roll.disadvantage"),
							callback: async html => {
								roll = await this.Roll(parts, data, html, -1, options);
							},
						},
					},
					default: "normal",
					close: () => {
						resolve(roll);
					},
					render: () => {
						// Check if the actor has advantage, and add highlight if that is the case
						if (data.actor?.hasAdvantage(data))	$("button.advantage")
							.attr("title", game.i18n.localize("SHADOWDARK.dialog.tooltip.talent_advantage"))
							.addClass("talent-highlight");
					},
				},
				options.dialogOptions
			).render(true);
		});
	}

	/* -------------------------------------------- */
	/*  Chat Card Generation for Displaying         */
	/* -------------------------------------------- */

	/**
	 * Parse roll data and optional target value
	 * @param {object} rollResult 		- Response from `_roll()`
	 * @param {object} speaker  			- ChatMessage.getSpeaker who will be sending the message
	 * @param {number|false} target 	- Target value to beat with the roll
	 * @return {object}								- Data for rendering a chatcard
	 */
	static _getChatCardData(rollResult, speaker, target=false) {
		const chatData = {
			user: game.user.id,
			speaker: speaker,
			flags: {
				isRoll: true,
				"core.canPopout": true,
				hasTarget: target !== false,
				critical: rollResult.critical,
			},
		};
		if (target) chatData.flags.success = rollResult.roll.total >= target;
		return chatData;
	}

	/**
	 * Generate Template Data for displaying custom chat cards
	 * @param {object} data 		- Optional data containing `item` and `actor`
	 * @param {object} options 	- Optional options for configuring chat card,
	 * e.g. `flavor`, `title`
	 * @returns {object}				- Data to populate the Chat Card template
	 */
	static _getChatCardTemplateData(data, options={}) {
		const templateData = {
			data,
			title: (options.title) ? options.title : game.i18n.localize("SHADOWDARK.chatcard.default"),
			flavor: (options.flavor)
				? options.flavor : (options.title)
					? options.title : game.i18n.localize("SHADOWDARK.chatcard.default"),
			isSpell: false,
			isWeapon: false,
			isVersatile: false,
			isRoll: true,
		};
		if (data.rolls.main) {
			templateData._formula = data.rolls.main._formula;
		}
		if (data.item) {
			templateData.isSpell = data.item.isSpell();
			templateData.isWeapon = data.item.isWeapon();
			templateData.isVersatile = data.item.isVersatile();
		}
		return templateData;
	}

	/**
	 * Generate HTML for a chat card for a roll
	 * @param {object} data 		- Optional data containing `item` and `actor`
	 * @param {object} options 	- Optional options for configuring chat card,
	 * e.g. `flavor`, `title`
	 * @returns {jQuery}				- Rendered HTML for chat card
	 */
	static async _getChatCardContent(
		data,
		options = {}
	) {
		const chatCardTemplate = options.chatCardTemplate
			? options.chatCardTemplate
			: "systems/shadowdark/templates/chat/roll-d20-card.hbs";

		const chatCardData = this._getChatCardTemplateData(data);

		return renderTemplate(chatCardTemplate, chatCardData);
	}

	/**
	 * Takes a data objcet containing rolls and renders them. Also optionally
	 * renders 3D Dice using Dice So Nice integration.
	 * @param {object} data 			- Data from rolling
	 * @param {-1|0|1} adv 				- Advantage indicator
	 * @param {object} options 		- Optional configuration for chat card
	 * @returns {Promise<object>}
	 */
	static async _renderRoll(data, adv=0, options={}) {
		const chatData = await this._getChatCardData(
			data.rolls.main,
			(options.speaker) ? options.speaker : ChatMessage.getSpeaker(),
			options.target
		);

		// @todo: Write tests for this.
		// Add whether the roll succeeded or not to the roll data
		data.rolls.main.success = (chatData.flags.success) ? chatData.flags.success : null;

		const content = await this._getChatCardContent(data, options);

		return new Promise(resolve => {
			// Setup the chat card
			if ( options.rollMode === "blindroll" ) chatData.blind = true;
			chatData.content = content;

			// Modify the flavor of the chat card
			if (options.flavor) {
				chatData.flavor = options.flavor;
				switch (adv) {
					case 1: chatData.flavor = game.i18n.format("SHADOWDARK.roll.advantage_title", { title: options.flavor }); break;
					case -1: chatData.flavor = game.i18n.format("SHADOWDARK.roll.disadvantage_title", { title: options.flavor }); break;
				}
			}

			// Integration with Dice So Nice
			if (game.dice3d) {
				resolve(this._rollDiceSoNice(data.rolls, chatData, options.chatMessage));
			}
			else {
				chatData.sound = CONFIG.sounds.dice;
				if (options.chatMessage !== false) ChatMessage.create(chatData);
				resolve(data);
			}
		});
	}

	/* -------------------------------------------- */
	/*  Integrations                                */
	/* -------------------------------------------- */

	/**
	 * Renders Dice So Nice in order of D20 -> Damage Rolls and creates
	 * a chat message with the generated content.
	 * @param {object} rolls 					- Object containing evaluated rolls
	 * @param {object} chatData 			- Parsed roll data as generated by _getchatCardData
	 * 																  augmented with content from
	 *                                  _getChatCardTemplateData
	 * @param {boolean} chatMessage 	- Boolean to display chat message or just generate it
	 * @return {object}								- Returns the D20 result
	 */
	static async _rollDiceSoNice(rolls, chatData, chatMessage) {
		game.dice3d
			.showForRoll(
				rolls.rollD20,
				game.user,
				true
			)
			.then(() => {
				if ( rolls.rollPrimaryDamage ) {
					game.dice3d
						.showForRoll(
							rolls.rollPrimaryDamage,
							game.user,
							true
						);
				}
				if ( rolls.rollSecondaryDamage ) {
					game.dice3d
						.showForRoll(
							rolls.rollSecondaryDamage,
							game.user,
							true
						);
				}
			})
			.then(() => {
				if (chatMessage !== false) ChatMessage.create(chatData);
				return rolls;
			});
	}
}
