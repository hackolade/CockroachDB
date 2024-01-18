const {clearEmptyPropertiesInObject, getColumnNameByPosition} = require('./common');

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

const prepareTablePartition = (partitionResult) => {
    if (!partitionResult) {
        return null;
    }

    const partitionMethod = getPartitionMethod(partitionResult);
    const compositePartitionKey = getCompositePartitionKey(partitionResult);
    const partitioning_expression = getPartitionExpression(partitionResult);

    return [
        {
            partitionMethod,
            compositePartitionKey,
            partitioning_expression,
        },
    ];
};

/**
 * @return {string}
 */
const getPartitionMethodByRow = (row = {}) => {
    if (row.list_value) {
        return 'LIST';
    }
    if (row.range_value) {
        return 'RANGE';
    }
    return '';
};

const getParentPartitionRows = (partitionResult = []) => {
    return partitionResult.filter(row => !row.parent_name);
}

const getChildPartitionRows = (partitionResult = [], parentName = null) => {
    return partitionResult.filter(row => row.parent_name === parentName);
}

/**
 * @return {string}
 */
const getPartitionMethod = (partitionResult = []) => {
    const parentPartitionRows = getParentPartitionRows(partitionResult);
    if (!parentPartitionRows.length) {
        return '';
    }
    const firstRow = parentPartitionRows[0];
    return getPartitionMethodByRow(firstRow);
};

const getCompositePartitionKey = (partitionResult = []) => {
    const parentPartitionRows = partitionResult.filter(row => !row.parent_name);
    const columnNames = parentPartitionRows
        .flatMap(row => {
            const columnNames = row.column_names || '';
            return columnNames.split(',').map(name => name.trim());
        })
    return _.uniq(columnNames);
}

const getPartitionExpression = (partitionResult) => {
    const parentPartitionRows = getParentPartitionRows(partitionResult);
    if (!parentPartitionRows.length) {
        return '';
    }
    const firstRow = parentPartitionRows[0];
    const partitionMethod = getPartitionMethodByRow(firstRow);
    const columnNames = firstRow.column_names || '';

    const parentPartitions = parentPartitionRows
        .map(row => getSinglePartitionExpression({
            partition: row,
            paddingFactor: 1,
            partitionResult
        }))
        .join(',\n');
    return `PARTITION BY ${partitionMethod} (${columnNames}) (
${parentPartitions}
)`
};

const getSinglePartitionExpression = ({
                                          partition,
                                          partitionResult,
                                          paddingFactor
                                      }) => {
    const valuesClause = partition.list_value ? 'VALUES IN' : 'VALUES FROM';
    const value = partition.list_value || partition.range_value || '';
    const baseDdlPadding = '\t'.repeat(paddingFactor);
    const baseDdl = `${baseDdlPadding}PARTITION ${partition.partition_name} ${valuesClause} ${value}`;

    const children = getChildPartitionRows(partitionResult, partition.partition_name);
    if (children.length) {
        const childPartitions = children.map(child => getSinglePartitionExpression({
            partition: child,
            partitionResult,
            paddingFactor: paddingFactor + 1,
        }))
            .join(',\n');

        const firstChildRow = children[0];
        const partitionMethod = getPartitionMethodByRow(firstChildRow);
        const columnNames = firstChildRow.column_names || '';
        return baseDdl + ` PARTITION BY ${partitionMethod} (${columnNames}) (\n`
            + childPartitions + '\n'
            + baseDdlPadding + ')'
    }
    return baseDdl;
}

const splitByEqualitySymbol = item => _.split(item, '=');

const checkHaveJsonTypes = columns => {
    return _.find(columns, {type: 'json'});
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
        ...(nullsDistinct && {nullsDistinct})
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

/**
 * @return {string}
 * */
const getIndexCreateStatement = (
    indexName,
    tableIndexesCreateStatementsResult = []
) => {
    const createStatementResultRow = tableIndexesCreateStatementsResult
        .find(result => result.index_name === indexName) || {};
    return createStatementResultRow.create_statement || '';
}

/**
 * @param method {string}
 * @return {string}
 * */
const parseIndexMethod = (method) => {
    if (method.toUpperCase() === 'INVERTED') {
        return 'gin';
    }
    return method;
}

const prepareTableIndexes = (
    tableIndexesResult,
    tableIndexesCreateStatementsResult = []
) => {
    return _.map(tableIndexesResult, indexData => {
        const createStatement = getIndexCreateStatement(indexData.indexname, tableIndexesCreateStatementsResult);

        const allColumns = mapIndexColumns(indexData, createStatement);
        const columns = _.slice(allColumns, 0, indexData.number_of_keys);
        const include = _.chain(allColumns)
            .slice(indexData.number_of_keys)
            .map(column => _.pick(column, 'name'))
            .value();

        const nullsDistinct = indexData.index_indnullsnotdistinct ? 'NULLS NOT DISTINCT' : '';

        const index = {
            indxName: indexData.indexname,
            index_method: parseIndexMethod(indexData.index_method),
            unique: indexData.index_unique ?? false,
            index_storage_parameter: getIndexStorageParameters(indexData.storage_parameters, createStatement),
            where: indexData.where_expression || '',
            include,
            columns,
            ...(nullsDistinct && {nullsDistinct}),
        };

        return clearEmptyPropertiesInObject(index);
    });
};

/**
 * @param columnName {string}
 * @param createStatement {string}
 * @return {number}
 * */
const getColumnDefinitionStart = ({createStatement, columnName}) => {
    let indexOfColumnNamePosition = 0;
    while(indexOfColumnNamePosition < createStatement.length) {
        const indexOfColumnName = createStatement.indexOf(columnName, indexOfColumnNamePosition);
        if (indexOfColumnName === -1) {
            return -1;
        }
        const nextChar = createStatement.charAt(indexOfColumnName + columnName.length);
        if (nextChar.match(/\s/)) {
            return indexOfColumnName;
        }
        indexOfColumnNamePosition = indexOfColumnName + columnName.length;
    }
}

/**
 * @param createStatement {string}
 * @param columnDefinitionStart {number}
 * @return {number}
 * */
const getColumnDefinitionEnd = ({createStatement, columnDefinitionStart}) => {
    const columnDefinitionWithRestOfTheQuery = createStatement.substring(columnDefinitionStart);
    const indexOfFirstComma = columnDefinitionWithRestOfTheQuery.indexOf(',');
    const indexOfFirstClosedParenthesis = columnDefinitionWithRestOfTheQuery.indexOf(')');
    if (indexOfFirstComma === -1) {
        return columnDefinitionStart + indexOfFirstClosedParenthesis;
    }
    return columnDefinitionStart + Math.min(indexOfFirstComma, indexOfFirstClosedParenthesis);
}

/**
 * @param columnName {string}
 * @param createStatement {string}
 * @return {string}
 * */
const getIndexColumnQueryDefinition = ({createStatement, columnName}) => {
    const columnDefinitionStart = getColumnDefinitionStart({ columnName, createStatement });
    if (columnDefinitionStart === -1) {
        return '';
    }
    const columnDefinitionEnd = getColumnDefinitionEnd({columnDefinitionStart, createStatement});
    if (columnDefinitionEnd === -1) {
        return '';
    }

    return createStatement.substring(columnDefinitionStart, columnDefinitionEnd);
}

/**
 * @param indexData {Object}
 * @param itemIndex {number}
 * @param columnName {string}
 * @param createStatement {string}
 * @return {string}
 * */
const getIndexColumnOpClass = ({indexData, itemIndex, columnName, createStatement}) => {
    const opclass = _.get(indexData, `opclasses.${itemIndex}`, '');
    if (opclass) {
        return opclass;
    }
    const columnDefinition = getIndexColumnQueryDefinition({ columnName, createStatement });
    if (!columnDefinition) {
        return '';
    }

    const definitionNoColumnName = columnDefinition.substring(columnName.length).trim();
    if (!definitionNoColumnName) {
        return '';
    }
    return definitionNoColumnName
        .toUpperCase()
        .replaceAll('ASC', '')
        .replaceAll('DESC', '')
        .replaceAll('NULLS FIRST', '')
        .replaceAll('NULLS LAST', '')
        .toLowerCase()
        .trim();
}

const mapIndexColumns = (indexData, createStatement) => {
    return _.chain(indexData.columns)
        .map((columnName, itemIndex) => {
            if (!columnName) {
                return;
            }

            const sortOrder = _.get(indexData, `ascendings.${itemIndex}`, 'ASC');
            const nullsOrder = _.get(indexData, `nulls_first.${itemIndex}`, 'NULLS FIRST');
            const opclass = getIndexColumnOpClass({
                columnName,
                createStatement,
                itemIndex,
                indexData
            });
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

/**
 * @return {Object}
 */
const hydrateIndexStorageParameters = (parameters) => {
    const data = {
        fillfactor: parameters.fillfactor,
        bucket_count: parameters.bucket_count,
        geometry_max_x: parameters.geometry_max_x,
        geometry_max_y: parameters.geometry_max_y,
        geometry_min_x: parameters.geometry_min_x,
        geometry_min_y: parameters.geometry_min_y,
        s2_level_mod: parameters.s2_level_mod,
        s2_max_cells: parameters.s2_max_cells,
        s2_max_level: parameters.s2_max_level,
    };

    return clearEmptyPropertiesInObject(data);
}

/**
 * @param createStatement {string}
 * @return {Object | null}
 * */
const parseIndexStorageParametersFromDdl = (createStatement) => {
    const storageParamsRegex = /\s+with\s+\(.*?\)/mi;
    const match = createStatement.match(storageParamsRegex);
    if (!match?.length) {
        return null;
    }
    // In the form of " WITH (param1=1,param2=2)"
    const rawStorageParamsClause = match[0];
    // Remove " WITH ("
    const indexToSubstringFrom = " WITH (".length;
    // Remove the last ")"
    const indexToSubstringTo = rawStorageParamsClause.length - 1;

    const keyValuePairs = rawStorageParamsClause.substring(indexToSubstringFrom, indexToSubstringTo)
        .split(',')
        .map(pair => pair.trim());

    const storageParameters = _.fromPairs(_.map(keyValuePairs, param => splitByEqualitySymbol(param)));
    return hydrateIndexStorageParameters(storageParameters);
}

/**
 * @param storageParameters {Object | undefined}
 * @param createStatement {string}
 * @return {Object | null}
 * */
const getIndexStorageParameters = (storageParameters, createStatement) => {
    if (!storageParameters) {
        return parseIndexStorageParametersFromDdl(createStatement);
    }

    const params = _.fromPairs(_.map(storageParameters, param => splitByEqualitySymbol(param)));
    return hydrateIndexStorageParameters(params);
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
    return _.map(inheritanceResult, ({parent_table_name}) => ({parentTable: [schemaName, parent_table_name]}));
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
