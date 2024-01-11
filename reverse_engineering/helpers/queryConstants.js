
const getGET_FUNCTIONS_WITH_PROCEDURES_ADDITIONAL = postgresVersion => {
	const kindQuery =
		postgresVersion === 10 ? `CASE WHEN proiswindow is true THEN 'w' ELSE '' END AS kind` : 'prokind AS kind';

	return `
        SELECT obj_description(oid, 'pg_proc') AS description,
            proname AS function_name,
            provolatile AS volatility,
            proparallel AS parallel,
            proisstrict AS strict,
            proretset AS returns_set,
            proleakproof AS leak_proof,
            procost AS estimated_cost,
            prorows AS estimated_rows,
            prosrc AS body,
            ${kindQuery}
        FROM pg_catalog.pg_proc WHERE pronamespace = $1;`;
};

const queryConstants = {
	PING: 'SELECT schema_name FROM information_schema.schemata LIMIT 1;',

    GET_VERSION: 'SELECT version()',

    GET_VERSION_AS_NUM: 'SHOW server_version_num;',

	GET_SCHEMA_NAMES: 'SELECT schema_name FROM information_schema.schemata;',

	GET_TABLE_NAMES: `
		SELECT tables.table_name, tables.table_type
		FROM information_schema.tables AS tables
		INNER JOIN (
			SELECT pg_class.relname AS table_name,
				   pg_namespace.nspname AS table_schema
			FROM pg_catalog.pg_class AS pg_class
				INNER JOIN pg_catalog.pg_namespace AS pg_namespace
				ON (pg_namespace.oid = pg_class.relnamespace)
			WHERE (pg_class.relispartition = false OR pg_class.relispartition IS NULL) AND pg_class.relkind = ANY ('{"r","v","t","m","p"}')
		) AS catalog_table_data
		ON (catalog_table_data.table_name = tables.table_name AND catalog_table_data.table_schema = tables.table_schema)
		WHERE tables.table_schema = $1;
	`,

	GET_NAMESPACE_OID: 'SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1',

    GET_TABLE_LEVEL_DATA: `
        SELECT pc.oid, pc.relpersistence, pc.reloptions, pg_get_expr(pc.relpartbound, pc.oid) AS partition_expr
            FROM pg_catalog.pg_class AS pc
            WHERE pc.relname = $1 AND pc.relnamespace = $2;`,

    GET_TABLE_TOAST_OPTIONS: `
        SELECT reloptions AS toast_options
        FROM pg_catalog.pg_class
        WHERE oid =
                (SELECT reltoastrelid
                 FROM pg_catalog.pg_class
                 WHERE relname=$1 AND relnamespace = $2
                 LIMIT 1)`,

    GET_TABLE_PARTITION_DATA: `
        SELECT partstrat as partition_method,
	            partattrs::int2[] as partition_attributes_positions,
	            pg_catalog.pg_get_expr(partexprs, partrelid) AS expressions
            FROM pg_catalog.pg_partitioned_table
            WHERE partrelid = $1;`,

	GET_TABLE_COLUMNS: `
        SELECT * FROM information_schema.columns
            WHERE table_name = $1 AND table_schema = $2
            ORDER BY ordinal_position`,

	GET_TABLE_COLUMNS_ADDITIONAL_DATA: `
        SELECT pg_attribute.attname AS name,
            pg_attribute.attndims AS number_of_array_dimensions,
            pg_description.description,
            pg_attribute.atttypmod AS attribute_mode
        FROM pg_catalog.pg_attribute AS pg_attribute
        LEFT JOIN pg_catalog.pg_description AS pg_description ON (pg_description.objsubid=pg_attribute.attnum
                                                               AND pg_description.objoid = pg_attribute.attrelid)
        WHERE pg_attribute.attrelid = $1;`,

	GET_DESCRIPTION_BY_OID: `SELECT obj_description($1, $2)`,

	GET_ROWS_COUNT: fullTableName => `SELECT COUNT(*) AS quantity FROM ${fullTableName};`,

	GET_SAMPLED_DATA: (fullTableName, jsonColumns) => `SELECT ${jsonColumns} FROM ${fullTableName} LIMIT $1;`,

    GET_SAMPLED_DATA_SIZE: (fullTableName, jsonColumns) => `
        SELECT sum(pg_column_size(_hackolade_tmp_sampling_tbl.*)) AS _hackolade_tmp_sampling_tbl_size 
        FROM (SELECT ${jsonColumns} FROM ${fullTableName} LIMIT $1) AS _hackolade_tmp_sampling_tbl;`,

    GET_TABLE_CONSTRAINTS: `
        SELECT pcon.conname AS constraint_name, 
	            pcon.contype AS constraint_type,
	            pcon.connoinherit AS no_inherit,
	            pcon.conkey AS constraint_keys,
	            pg_catalog.pg_get_expr(pcon.conbin, pcon.conrelid) AS expression,
	            obj_description(pcon.oid, 'pg_constraint') AS description,
	            pc.reloptions AS storage_parameters,
	            pt.spcname AS tablespace
	        FROM pg_catalog.pg_constraint AS pcon
	        LEFT JOIN pg_catalog.pg_class AS pc
	        ON pcon.conindid = pc.oid
	        LEFT JOIN pg_catalog.pg_tablespace AS pt
	        ON pc.reltablespace = pt.oid
	        WHERE pcon.conrelid = $1;`,

    GET_TABLE_INDEXES: `
    SELECT indexname,
           index_method,
           index_unique,
           index_indnullsnotdistinct,
           number_of_keys,
           where_expression,
           array_agg(attname ORDER BY ord)::text[] AS columns,
           array_agg(coll ORDER BY ord) AS collations,
           array_agg(opclass ORDER BY ord) AS opclasses,
           array_agg(expression ORDER BY ord) AS expressions,
           array_agg(ascending ORDER BY ord) AS ascendings,
           array_agg(nulls_first ORDER BY ord) AS nulls_first,
           reloptions AS storage_parameters,
           tablespace_name
    FROM (
        SELECT ct.oid AS table_oid,
            c.relname AS indexname,
            m.amname AS index_method,
            indexes.indisunique AS index_unique,
            indexes.indnullsnotdistinct AS index_indnullsnotdistinct,
            indexes.ord,
            attribute.attname,
            c.reloptions,
            tablespace_t.spcname AS tablespace_name,
            indexes.indnkeyatts AS number_of_keys,
            pg_catalog.pg_get_expr(indpred, indrelid) AS where_expression,
            CASE
                WHEN collation_namespace.nspname is not null THEN format('%I.%I',collation_namespace.nspname,collation_t.collname)
            END AS coll,
            CASE
                WHEN opclass_t.opcname is not null THEN format('%I.%I',opclas_namespace.nspname,opclass_t.opcname)
            END AS opclass,
        CASE
            WHEN NOT m.amcanorder THEN ''
            WHEN indexes.indoption[indexes.ord - 1] & 1 = 1 THEN 'DESC' ELSE 'ASC'
        END AS ascending,
        CASE
            WHEN NOT m.amcanorder THEN ''
            WHEN indexes.indoption[indexes.ord - 1] & 2 = 2 THEN 'NULLS FIRST' ELSE 'NULLS LAST'
        END AS nulls_first,
        pg_catalog.pg_get_indexdef(indexes.indexrelid, ord, false) AS expression
        FROM
            (
                SELECT *,
                    generate_series(1,array_length(i.indkey,1)) AS ord,
                    unnest(i.indkey) AS key,
                    unnest(i.indcollation) AS coll,
                    unnest(i.indclass) AS class,
                    unnest(i.indoption) AS option
                FROM pg_catalog.pg_index i
            ) indexes
        JOIN pg_catalog.pg_class c ON (c.oid=indexes.indexrelid)
        JOIN pg_catalog.pg_class ct ON (ct.oid=indexes.indrelid)
        JOIN pg_catalog.pg_am m ON (m.oid=c.relam)
        LEFT JOIN pg_catalog.pg_attribute attribute
            ON (attribute.attrelid=indexes.indrelid AND attribute.attnum=indexes.key)
        LEFT JOIN pg_catalog.pg_collation collation_t ON (collation_t.oid=indexes.coll)
        LEFT JOIN pg_catalog.pg_namespace collation_namespace ON (collation_namespace.oid=collation_t.collnamespace)
        LEFT JOIN pg_catalog.pg_opclass opclass_t ON (opclass_t.oid=indexes.class)
        LEFT JOIN pg_catalog.pg_namespace opclas_namespace ON (opclas_namespace.oid=opclass_t.opcnamespace)
        LEFT JOIN pg_catalog.pg_tablespace tablespace_t ON (tablespace_t.oid = c.reltablespace)
    ) s2
    WHERE table_oid = $1
    GROUP BY
        indexname,
        index_method,
        index_unique,
        index_indnullsnotdistinct,
        reloptions,
        number_of_keys,
        where_expression,
        tablespace_name;
    `,

    GET_TABLE_FOREIGN_KEYS: `
        SELECT pcon.conname AS relationship_name, 
                pcon.conkey AS table_columns_positions,
                pcon.confdeltype AS relationship_on_delete,
                pcon.confupdtype AS relationship_on_update,
                pcon.confmatchtype AS relationship_match,
                pc_foreign_table.relname AS foreign_table_name, 
                ARRAY(
                    SELECT column_name::text FROM unnest(pcon.confkey) AS column_position 
                    JOIN information_schema.columns ON (ordinal_position = column_position)
                    WHERE table_name = pc_foreign_table.relname AND table_schema = foreign_table_namespace.nspname)::text[] AS foreign_columns,
                foreign_table_namespace.nspname AS foreign_table_schema
            FROM pg_catalog.pg_constraint AS pcon
            LEFT JOIN pg_catalog.pg_class AS pc ON pcon.conindid = pc.oid
            LEFT JOIN pg_catalog.pg_tablespace AS pt ON pc.reltablespace = pt.oid
            LEFT JOIN pg_catalog.pg_class AS pc_foreign_table ON (pcon.confrelid = pc_foreign_table.oid)
            JOIN pg_catalog.pg_namespace AS foreign_table_namespace ON (pc_foreign_table.relnamespace = foreign_table_namespace.oid)
            WHERE pcon.conrelid = $1 AND pcon.contype = 'f';`,

    GET_VIEW_DATA: `SELECT * FROM information_schema.views WHERE table_name = $1 AND table_schema = $2;`,

    GET_VIEW_SELECT_STMT_FALLBACK: `SELECT definition FROM pg_views WHERE viewname = $1 AND schemaname = $2;`,

    GET_VIEW_OPTIONS: `
        SELECT oid, 
            reloptions AS view_options,
            relpersistence AS persistence,
            obj_description(oid, 'pg_class') AS description
        FROM pg_catalog.pg_class 
        WHERE relname = $1 AND relnamespace = $2;`,

    GET_FUNCTIONS_WITH_PROCEDURES: `
        SELECT specific_name,
            routine_name AS name,
            routine_type,
            routine_definition,
            external_language,
            security_type,
            type_udt_name AS return_data_type
	    FROM information_schema.routines
	    WHERE specific_schema=$1;`,

    GET_FUNCTIONS_WITH_PROCEDURES_ARGS: `
        SELECT parameter_name,
            parameter_mode,
            parameter_default,
            data_type,
            udt_name
        FROM information_schema.parameters
        WHERE specific_name = $1
        ORDER BY ordinal_position;`,

    GET_FUNCTIONS_WITH_PROCEDURES_ADDITIONAL: getGET_FUNCTIONS_WITH_PROCEDURES_ADDITIONAL(),

    GET_FUNCTIONS_WITH_PROCEDURES_ADDITIONAL_V_10: getGET_FUNCTIONS_WITH_PROCEDURES_ADDITIONAL(10),

    GET_USER_DEFINED_TYPES: `
        SELECT pg_type.typrelid AS pg_class_oid,
            pg_type.typname AS name,
            pg_type.typtype AS type,
            pg_catalog.array_agg(pg_enum.enumlabel)::text[] AS enum_values,
            range_subtype_type.typname AS range_subtype,
            range_collation.collname AS range_collation_name,
            range_opclass.opcname AS range_opclass_name,
            range_canonical_proc.proname AS range_canonical_proc,
            range_diff_proc.proname AS range_diff_proc
        FROM pg_catalog.pg_type AS pg_type
        LEFT JOIN pg_catalog.pg_class AS pg_class ON (pg_class.oid = pg_type.typrelid)
        LEFT JOIN pg_catalog.pg_namespace AS pg_namespace ON (pg_namespace.oid = pg_type.typnamespace)
        LEFT JOIN pg_catalog.pg_enum AS pg_enum ON (pg_enum.enumtypid = pg_type.oid)
        LEFT JOIN pg_catalog.pg_range AS pg_range ON (pg_range.rngtypid = pg_type.oid)
        LEFT JOIN pg_catalog.pg_type AS range_subtype_type ON (range_subtype_type.oid = pg_range.rngsubtype)
        LEFT JOIN pg_catalog.pg_collation AS range_collation ON (range_collation.oid = pg_range.rngcollation)
        LEFT JOIN pg_catalog.pg_opclass AS range_opclass ON (range_opclass.oid = pg_range.rngsubopc)
        LEFT JOIN pg_catalog.pg_proc AS range_canonical_proc ON (range_canonical_proc.oid = pg_range.rngcanonical)
        LEFT JOIN pg_catalog.pg_proc AS range_diff_proc ON (range_diff_proc.oid = pg_range.rngsubdiff)
        WHERE pg_namespace.nspname = $1
         AND ((pg_type.typtype = 'c'
               AND pg_class.relkind = 'c')
              OR pg_type.typtype = 'e'
              OR pg_type.typtype = 'r')
        GROUP BY pg_class_oid,
              pg_type.typname,
              pg_type.typtype,
              pg_class.oid,
              range_subtype,
              range_collation_name,
              range_opclass_name,
              range_canonical_proc,
              range_diff_proc;`,

    GET_COMPOSITE_TYPE_COLUMNS: `
        SELECT pg_attribute.attname AS column_name,
           pg_type.typname AS data_type,
           pg_get_expr(pg_attrdef.adbin, pg_attrdef.adrelid) AS columns_default,
           pg_attribute.attnotnull AS not_null,
           pg_collation.collname AS collation_name,
           pg_attribute.attndims AS number_of_array_dimensions,
           pg_attribute.atttypmod AS character_maximum_length
        FROM pg_catalog.pg_attribute AS pg_attribute
        LEFT JOIN pg_catalog.pg_type AS pg_type ON (pg_type.oid = pg_attribute.atttypid)
        LEFT JOIN pg_catalog.pg_attrdef AS pg_attrdef ON (pg_attrdef.adrelid = pg_attribute.attrelid
                                                          AND pg_attrdef.adnum = pg_attribute.attnum)
        LEFT JOIN pg_catalog.pg_collation AS pg_collation ON (pg_collation.oid = pg_attribute.attcollation)
        WHERE pg_attribute.attrelid = $1`,

    GET_DB_NAME: 'SELECT current_database();',

    GET_DB_ENCODING: 'SHOW SERVER_ENCODING;',

    GET_DB_COLLATE_NAME: 'SELECT default_collate_name FROM information_schema.character_sets;',

    GET_DATABASES:
		'SELECT datname AS database_name FROM pg_catalog.pg_database WHERE datistemplate != TRUE AND datallowconn = TRUE;',

};

const getQueryName = query => {
	const queryEntry =
		Object.entries(queryConstants).find(([queryName, constantQuery]) => query === constantQuery) || [];

	return queryEntry[0] || 'Custom query';
};

module.exports = {
	getQueryName,
	...queryConstants,
};
