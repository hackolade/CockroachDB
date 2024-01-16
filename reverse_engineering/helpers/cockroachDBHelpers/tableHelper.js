const { clearEmptyPropertiesInObject, getColumnNameByPosition } = require('./common');
const {values} = require("pg/lib/native/query");

let _ = null;

const setDependencies = app => {
	_ = app.require('lodash');
};

const groupTtlStorageParams = (options) => {
	const result = {};
	for (const key of Object.keys(options)) {
		if (key.startsWith('ttl')) {
			if (!result.ttl_storage_parameters) {
				result.ttl_storage_parameters = {};
			}

			result.ttl_storage_parameters[key] = options[key];
		} else {
			result[key] = options[key];
		}
	}
	return result;
}

const prepareStorageParameters = (reloptions, tableToastOptions) => {
	if (!reloptions && !tableToastOptions) {
		return null;
	}

	const options = prepareOptions(reloptions);
	const nonEmptyOptions = clearEmptyPropertiesInObject(options);
	const optionsWithGroupedTtl = groupTtlStorageParams(nonEmptyOptions);
	return clearEmptyPropertiesInObject(optionsWithGroupedTtl);
};

const prepareTablePartition = (partitionResult, tableColumns) => {
	if (!partitionResult) {
		return null;
	}

	const partitionMethod = getPartitionMethod(partitionResult);
	const isExpression = _.some(partitionResult.partition_attributes_positions, position => position === 0);
	const key = isExpression ? 'partitioning_expression' : 'compositePartitionKey';
	const value = isExpression
		? getPartitionExpression(partitionResult, tableColumns)
		: _.map(partitionResult.partition_attributes_positions, getColumnNameByPosition(tableColumns));

	return [
		{
			partitionMethod,
			partitionBy: isExpression ? 'expression' : 'keys',
			[key]: value,
		},
	];
};

const getPartitionMethod = partitionResult => {
	const type = partitionResult.partition_method;

	switch (type) {
		case 'h':
			return 'HASH';
		case 'l':
			return 'LIST';
		case 'r':
			return 'RANGE';
		default:
			return '';
	}
};

const getPartitionExpression = (partitionResult, tableColumns) => {
	let expressionIndex = 0;
	const expressions = _.split(partitionResult.expressions, ',');

	return _.chain(partitionResult.partition_attributes_positions)
		.map(attributePosition => {
			if (attributePosition === 0) {
				const expression = expressions[expressionIndex];
				expressionIndex++;

				return expression;
			}

			return getColumnNameByPosition(tableColumns)(attributePosition);
		})
		.join(',')
		.value();
};

const splitByEqualitySymbol = item => _.split(item, '=');

const checkHaveJsonTypes = columns => {
	return _.find(columns, { type: 'json' });
};

const getSampleDocSize = (count, recordSamplingSettings) => {
	if (recordSamplingSettings.active === 'absolute') {
		return Number(recordSamplingSettings.absolute.value);
	}

	const limit = Math.ceil((count * recordSamplingSettings.relative.value) / 100);

	return Math.min(limit, recordSamplingSettings.maxValue);
};

const prepareTableConstraints = (constraintsResult, attributesWithPositions, tableIndexes) => {
	return _.reduce(
		constraintsResult,
		(entityConstraints, constraint) => {
			switch (constraint.constraint_type) {
				case 'c':
					return {
						...entityConstraints,
						chkConstr: [...entityConstraints.chkConstr, getCheckConstraint(constraint)],
					};
				case 'p':
					return {
						...entityConstraints,
						primaryKey: [
							...entityConstraints.primaryKey,
							getPrimaryKeyConstraint(constraint, attributesWithPositions),
						],
					};
				case 'u':
					return {
						...entityConstraints,
						uniqueKey: [
							...entityConstraints.uniqueKey,
							getUniqueKeyConstraint(constraint, attributesWithPositions, tableIndexes),
						],
					};
				default:
					return entityConstraints;
			}
		},
		{
			chkConstr: [],
			uniqueKey: [],
			primaryKey: [],
		},
	);
};

const getPrimaryKeyConstraint = (constraint, tableColumns) => {
	return {
		constraintName: constraint.constraint_name,
		compositePrimaryKey: _.map(constraint.constraint_keys, getColumnNameByPosition(tableColumns)),
		indexStorageParameters: _.join(constraint.storage_parameters, ','),
	};
};

const getUniqueKeyConstraint = (constraint, tableColumns, tableIndexes) => {
	const indexWithConstraint = _.find(tableIndexes, index => index.indexname === constraint.constraint_name);
	const nullsDistinct = indexWithConstraint?.index_indnullsnotdistinct ? 'NULLS NOT DISTINCT' : '';

	return {
		constraintName: constraint.constraint_name,
		compositeUniqueKey: _.map(constraint.constraint_keys, getColumnNameByPosition(tableColumns)),
		indexStorageParameters: _.join(constraint.storage_parameters, ','),
		indexComment: constraint.description,
		...(nullsDistinct && { nullsDistinct })
	};
};

const getCheckConstraint = constraint => {
	return {
		chkConstrName: constraint.constraint_name,
		constrExpression: constraint.expression,
		noInherit: constraint.no_inherit,
		constrDescription: constraint.description,
	};
};

const prepareTableIndexes = tableIndexesResult => {
	return _.map(tableIndexesResult, indexData => {
		const allColumns = mapIndexColumns(indexData);
		const columns = _.slice(allColumns, 0, indexData.number_of_keys);
		const include = _.chain(allColumns)
			.slice(indexData.number_of_keys)
			.map(column => _.pick(column, 'name'))
			.value();

		const nullsDistinct = indexData.index_indnullsnotdistinct ? 'NULLS NOT DISTINCT' : '';

		const index = {
			indxName: indexData.indexname,
			index_method: indexData.index_method,
			unique: indexData.index_unique ?? false,
			index_storage_parameter: getIndexStorageParameters(indexData.storage_parameters),
			where: indexData.where_expression || '',
			include,
			columns:
				indexData.index_method === 'btree'
					? columns
					: _.map(columns, column => _.omit(column, 'sortOrder', 'nullsOrder')),
			...(nullsDistinct && { nullsDistinct }),
		};

		return clearEmptyPropertiesInObject(index);
	});
};

const mapIndexColumns = indexData => {
	return _.chain(indexData.columns)
		.map((columnName, itemIndex) => {
			if (!columnName) {
				return;
			}

			const sortOrder = _.get(indexData, `ascendings.${itemIndex}`, 'ASC');
			const nullsOrder = _.get(indexData, `nulls_first.${itemIndex}`, 'NULLS FIRST');
			const opclass = _.get(indexData, `opclasses.${itemIndex}`, '');
			const collation = _.get(indexData, `collations.${itemIndex}`, '');

			return {
				name: columnName,
				sortOrder,
				nullsOrder,
				opclass,
				collation,
			};
		})
		.compact()
		.value();
};

const getIndexStorageParameters = storageParameters => {
	if (!storageParameters) {
		return null;
	}

	const params = _.fromPairs(_.map(storageParameters, param => splitByEqualitySymbol(param)));

	const data = {
		index_fillfactor: params.fillfactor,
		deduplicate_items: params.deduplicate_items,
		index_buffering: params.index_buffering,
		fastupdate: params.fastupdate,
		gin_pending_list_limit: params.gin_pending_list_limit,
		pages_per_range: params.pages_per_range,
		autosummarize: params.autosummarize,
	};

	return clearEmptyPropertiesInObject(data);
};

const prepareTableLevelData = (tableLevelData, tableToastOptions) => {
	const temporary = tableLevelData?.relpersistence === 't';
	const unlogged = tableLevelData?.relpersistence === 'u';
	const storage_parameter = prepareStorageParameters(tableLevelData?.reloptions, tableToastOptions);
	const partitionBounds = tableLevelData.partition_expr;

	return {
		temporary,
		unlogged,
		storage_parameter,
		partitionBounds,
	};
};

const convertValueToType = value => {
	switch (getTypeOfValue(value)) {
		case 'number':
		case 'boolean':
			return JSON.parse(value);
		case 'string':
		default:
			return value;
	}
};

const getTypeOfValue = value => {
	try {
		const type = typeof JSON.parse(value);

		if (type === 'object') {
			return 'string';
		}

		return type;
	} catch (error) {
		return 'string';
	}
};

const prepareOptions = options => {
	return (
		_.chain(options)
			.map(splitByEqualitySymbol)
			.map(([key, value]) => [key, convertValueToType(value)])
			.fromPairs()
			.value() || {}
	);
};

const prepareTableInheritance = (schemaName, inheritanceResult) => {
	return _.map(inheritanceResult, ({ parent_table_name }) => ({ parentTable: [schemaName, parent_table_name] }));
};

module.exports = {
	prepareStorageParameters,
	prepareTablePartition,
	setDependencies,
	checkHaveJsonTypes,
	prepareTableConstraints,
	prepareTableLevelData,
	prepareTableIndexes,
	getSampleDocSize,
	prepareTableInheritance,
};
